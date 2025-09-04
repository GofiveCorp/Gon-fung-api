import { Api } from './api/methods'
import { Events } from './events'
import { server } from './server'
import { GLOBAL } from './singleton'
import { MeetingStateMachine } from './state-machine/machine'
import { detectMeetingProvider } from './utils/detectMeetingProvider'
import { createAudioTranscriber, type AudioTranscriberStartArgs } from './transcribe/meeting_transcriber'
import { createMeetingSummarizer } from "./summarize/ai_summarizer";
import { S3Uploader } from './utils/S3Uploader_new'

import path from "path";
import fs from "fs";

import {
    setupConsoleLogger,
    setupExitHandler,
    uploadLogsToS3,
} from './utils/Logger'
import { PathManager } from './utils/PathManager'

import { getErrorMessageFromCode } from './state-machine/types'
import { MeetingParams } from './types'

import { exit } from 'process'

// ========================================
// CONFIGURATION
// ========================================

// Setup console logger first to ensure proper formatting
setupConsoleLogger()

// Setup crash handlers to upload logs in case of unexpected exit
setupExitHandler()

// Configuration to enable/disable DEBUG logs
export const DEBUG_LOGS =
    process.argv.includes('--debug') || process.env.DEBUG_LOGS === 'true'
if (DEBUG_LOGS) {
    console.log('🐛 DEBUG mode activated - speakers debug logs will be shown')
}

// ========================================
// UTILITY FUNCTIONS
// ========================================

/**
 * Read and parse meeting parameters from stdin
 */
async function readFromStdin(): Promise<MeetingParams> {
    return new Promise((resolve) => {
        let data = ''
        process.stdin.on('data', (chunk) => {
            data += chunk
        })

        process.stdin.on('end', () => {
            try {
                const params = JSON.parse(data) as MeetingParams

                // Detect the meeting provider
                params.meetingProvider = detectMeetingProvider(
                    params.meeting_url,
                )
                GLOBAL.set(params)
                PathManager.getInstance().initializePaths()
                resolve(params)
            } catch (error) {
                console.error('Failed to parse JSON from stdin:', error)
                console.error('Raw data was:', JSON.stringify(data))
                process.exit(1)
            }
        })
    })
}

/**
 * Handle successful recording completion
 */
async function handleSuccessfulRecording(): Promise<void> {
    console.log(`${Date.now()} Finalize project && Sending WebHook complete`)

    // Log the end reason for debugging
    console.log(
        `Recording ended normally with reason: ${MeetingStateMachine.instance.getEndReason()}`,
    )

    // Handle API endpoint call with built-in retry logic
    if (!GLOBAL.isServerless()) {
        await Api.instance.handleEndMeetingWithRetry()
    }

    // Send success webhook
    await Events.recordingSucceeded()
}

export async function transcribeMeetingAudio(): Promise<void> {
  const params: any = GLOBAL.get?.() ?? {};
  const uuid: string | undefined = params?.bot_uuid;
  if (!uuid) { console.warn("[transcribe] no bot_uuid in GLOBAL — skip"); return; }

  const pm: any = (PathManager as any)?.getInstance?.();
  const recordingsDir = pm?.paths?.recordingsDir ?? path.resolve(process.cwd(), "recordings");
  const base =  PathManager.getInstance().getBasePath();

  console.log("📝 [transcribe] start — waiting for artifacts in:", base);

  const media = path.join(base, "output.wav");

  const identifier = `${uuid}/transcripts_by_speaker.json`

  const log   = path.join(base, "speaker_separation.log");
  const out = path.join(base, "transcripts_by_speaker.json");
  const haveMedia = fs.existsSync(media);
  const haveLog   = fs.existsSync(log);
  console.log("📝 [transcribe] artifacts:", { media, haveMedia, log, haveLog, out });

  const transcriber = createAudioTranscriber({ preprocess: true });

  transcriber.on("progress", (p) => process.env.DEBUG_LOGS === "true" && console.log(`[transcribe] ${p.index}/${p.total} ${p.speaker}`));
  transcriber.on("error", (e) => console.error("[transcribe] error:", e));

  await transcriber.start({ media, log, out } as AudioTranscriberStartArgs);
  console.log("✅ [transcribe] done ->", out);
  try {
    if (fs.existsSync(out)) {
        console.log(
            `📤 Uploading transcripts_by_speaker to bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
        )
        await S3Uploader.getInstance().uploadFile(
            out,
            GLOBAL.get().remote?.aws_s3_video_bucket!,
            identifier,
        )
        // fs.unlinkSync(this.audioOutputPath)
        }
    } catch (error) {
        console.error('Failed to upload transcripts_by_speaker file:', error)
        // Don't throw - continue with video upload
    }
  fs.unlinkSync(media)
}

export async function summarizeMeetingAudio(): Promise<void> {
  const params: any = GLOBAL.get?.() ?? {};
  const uuid: string | undefined = params?.bot_uuid;
  if (!uuid) {
    console.warn("[summarize] no bot_uuid in GLOBAL — skip");
    return;
  }

  const identifier = `${uuid}/meeting_summary.txt`

  const pm: any = (PathManager as any)?.getInstance?.();
  const recordingsDir = pm?.paths?.recordingsDir ?? path.resolve(process.cwd(), "recordings");
  const base =  PathManager.getInstance().getBasePath();

  const jsonInput = path.join(base, "transcripts_by_speaker.json");
  const outSummary = path.join(base, "meeting_summary.txt");

  console.log("📝 [summarize] start — summarizing meeting:", jsonInput);

  try {
    const summarizer = createMeetingSummarizer({ model: "gpt-5-mini" ,systemPrompt : "สรุปมาแบบสั้นๆแต่ได้ใจความ"});
    summarizer.on("progress", (p) => console.log("[summarize progress]", p));
    summarizer.on("error", (e) => console.error("[summarize error]", e));
    summarizer.on("done", (d) => console.log("[summarize done]", d.out));

    await summarizer.start({
      inputJson: jsonInput,
      out: outSummary,
    });

    console.log("✅ [summarize] summary written to:", outSummary);
    try {
        if (fs.existsSync(outSummary)) {
            console.log(
                `📤 Uploading summary to bucket: ${GLOBAL.get().remote?.aws_s3_video_bucket}`,
            )
            await S3Uploader.getInstance().uploadFile(
                outSummary,
                GLOBAL.get().remote?.aws_s3_video_bucket!,
                identifier,
            )
            // fs.unlinkSync(this.audioOutputPath)
            }
    } catch (error) {
        console.error('Failed to upload summary  file:', error)
        // Don't throw - continue with video upload
    }
  } catch (err) {
    console.error("❌ [summarize] failed:", err);
  }
}

/**
 * Handle failed recording
 */
async function handleFailedRecording(): Promise<void> {
    console.error('Recording did not complete successfully')

    // Log the end reason for debugging
    const endReason = GLOBAL.getEndReason()
    console.log(`Recording failed with reason: ${endReason || 'Unknown'}`)

    console.log(`📤 Sending error to backend`)

    // Notify backend of recording failure (function deduces errorCode and message automatically)
    if (!GLOBAL.isServerless() && Api.instance) {
        await Api.instance.notifyRecordingFailure()
    }

    // Send failure webhook to user
    const errorMessage = endReason
        ? getErrorMessageFromCode(endReason)
        : 'Recording did not complete successfully'
    await Events.recordingFailed(errorMessage)
    console.log(`✅ Error sent to backend successfully`)
}

// ========================================
// MAIN ENTRY POINT
// ========================================

/**
 * Main application entry point
 *
 * Syntax conventions:
 * - minus => Library
 * - CONST => Const
 * - camelCase => Fn
 * - PascalCase => Classes
 */
;(async () => {
    const meetingParams = await readFromStdin()

    try {
        // Log all meeting parameters (masking sensitive data)
        const logParams = { ...meetingParams }

        // Mask sensitive data for security
        if (logParams.user_token) logParams.user_token = '***MASKED***'
        if (logParams.bots_api_key) logParams.bots_api_key = '***MASKED***'
        if (logParams.speech_to_text_api_key)
            logParams.speech_to_text_api_key = '***MASKED***'
        if (logParams.zoom_sdk_pwd) logParams.zoom_sdk_pwd = '***MASKED***'

        console.log(
            'Received meeting parameters:',
            JSON.stringify(logParams, null, 2),
        )

        console.log('About to redirect logs to bot:', meetingParams.bot_uuid)
        console.log('Logs redirected successfully')

        // Start the server
        await server().catch((e) => {
            console.error(`Failed to start server: ${e}`)
            throw e
        })
        console.log('Server started successfully')

        // Initialize components
        MeetingStateMachine.init()
        Events.init()
        Events.joiningCall()

        // Create API instance for non-serverless mode
        if (!GLOBAL.isServerless()) {
            new Api()
        }

        // Start the meeting recording
        await MeetingStateMachine.instance.startRecordMeeting()

        // Handle recording result
        if (MeetingStateMachine.instance.wasRecordingSuccessful()) {
            await handleSuccessfulRecording()

            if (meetingParams.speech_to_text_provider == "Azure") {
                console.log("→ calling transcribeMeetingAudio()");
                await transcribeMeetingAudio();

                if (meetingParams.ai_summarization == true) {
                    console.log("→ calling summarizeMeetingAudio()");
                    await summarizeMeetingAudio();
                }
            }

        } else {
            await handleFailedRecording()
        }
    } catch (error) {
        // Handle explicit errors from state machine
        console.error(
            'Meeting failed:',
            error instanceof Error ? error.message : error,
        )

        // Use global error if available, otherwise fallback to error message
        const errorMessage = GLOBAL.hasError()
            ? GLOBAL.getErrorMessage() || 'Unknown error'
            : error instanceof Error
              ? error.message
              : 'Recording failed to complete'

        console.log(`📤 Sending error to backend: ${errorMessage}`)

        // Notify backend of recording failure
        if (!GLOBAL.isServerless() && Api.instance) {
            await Api.instance.notifyRecordingFailure()
        }

        await Events.recordingFailed(errorMessage)
        console.log(`✅ Error sent to backend successfully`)
    } finally {
        if (!GLOBAL.isServerless()) {
            try {
                await uploadLogsToS3({})
            } catch (error) {
                console.error('Failed to upload logs to S3:', error)
            }
        }
        console.log('exiting instance')
        exit(0)
    }
})()
