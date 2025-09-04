// src/summarize/meeting_summarizer.ts
// Shape ให้คล้าย meeting_transcriber.ts: มีคลาส + create* + อีเวนต์ progress/done/error
import fs from "fs/promises";
import path from "path";
import { EventEmitter } from "events";
import 'dotenv/config';
import OpenAI from "openai";

export interface MeetingSummarizerStartArgs {
  /** path ไปยัง transcripts_by_speaker.json (อ่านแบบ "ดิบ" ไม่ parse) */
  inputJson: string;
  /** path ไฟล์สรุปที่จะบันทึก (ค่าเริ่มต้น: <dir>/meeting_summary.txt) */
  out?: string;
  /** system prompt ถ้าอยาก override */
  systemPrompt?: string;
  /** รุ่นโมเดล ถ้าอยาก override */
  model?: string;
}

export interface MeetingSummarizerOptions {
  /** รุ่นโมเดลเริ่มต้น */
  model?: string;
  /** system prompt เริ่มต้น */
  systemPrompt?: string;
}

export class MeetingSummarizer extends EventEmitter {
  private running = false;
  private client: OpenAI;
  private defaultModel: string;
  private defaultPrompt: string;

  constructor(opts: MeetingSummarizerOptions = {}) {
    super();
    this.client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    this.defaultModel = opts.model ?? "gpt-5-mini";
    this.defaultPrompt = opts.systemPrompt ?? DEFAULT_PROMPT;
  }

  stop() {
    this.running = false;
  }

  async start(args: MeetingSummarizerStartArgs): Promise<string> {
    const { inputJson, out, systemPrompt, model } = args;
    if (this.running) throw new Error("MeetingSummarizer is already running");
    this.running = true;

    try {
      this.emit("progress", { stage: "read_file_start", inputJson });

      // 1) อ่านไฟล์ JSON แบบ "ดิบ" (ไม่ parse)
      const rawJsonText = await fs.readFile(inputJson, "utf-8");
      this.emit("progress", { stage: "read_file_done", size: rawJsonText.length });

      // 2) เตรียมค่า prompt / model
      const sys = systemPrompt ?? this.defaultPrompt;
      const mdl = model ?? this.defaultModel;

      // 3) เรียกโมเดล
      this.emit("progress", { stage: "model_call_start", model: mdl });
      const resp = await this.client.chat.completions.create({
        model: mdl,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: `สรุปประเด็นสำคัญการประชุมจากบทถอดเสียงต่อไปนี้:\n\n${rawJsonText}` },
        ],
      });
      const summary = resp.choices?.[0]?.message?.content?.trim() ?? "";
      if (!summary) throw new Error("No summary returned from model.");
      this.emit("progress", { stage: "model_call_done", chars: summary.length });

      // 4) เขียนไฟล์ผลลัพธ์
      const outPath = out ?? defaultOutPathFromInput(inputJson);
      await fs.writeFile(outPath, summary, "utf-8");
      this.emit("progress", { stage: "write_done", out: outPath });

      this.emit("done", { out: outPath, summary });
      return summary;
    } catch (err) {
      this.emit("error", err);
      throw err;
    } finally {
      this.running = false;
    }
  }
}

export function createMeetingSummarizer(opts: MeetingSummarizerOptions = {}) {
  return new MeetingSummarizer(opts);
}

/** ===== Utilities & Defaults ===== */
function defaultOutPathFromInput(inputJson: string) {
  const dir = path.dirname(inputJson);
  return path.join(dir, "meeting_summary.txt");
}

const DEFAULT_PROMPT = `ช่วยทำตัวเป็นเลขาการประชุมที่มีประสบการณ์ทั้งในด้านการขายและการจดสรุปการประชุม โดยข้อมูลจะมาจากวิดีโอที่อัปโหลด

เป้าหมาย: สร้างรายงานหลังการประชุมโดยสรุปประเด็นสำคัญต่าง ๆ ในรูปแบบที่เข้าใจง่ายและตรงตาม format ที่เรากำหนดไว้ เพื่อให้พนักงานขายสามารถทำความเข้าใจต่อได้ทันที โดยต้องสรุปเป็นภาษาไทย

เพิ่มเติม: หากหัวข้อใดที่กำหนดไว้แล้วไม่รู้คำตอบ หรือไม่สามารถสรุปได้ ให้เว้นว่างไว้ หรือใส่คำว่า "ไม่ระบุ" โดยไม่ต้องใส่ข้อมูลที่ไม่มั่นใจ

1. ผู้เข้าร่วมประชุมและบทบาท
• ลิสต์ผู้เข้าร่วมประชุม โดยแยกให้เห็นว่ามาจากฝั่งลูกค้าหรือฝั่งเรา พร้อมตำแหน่งของแต่ละคน
• ระบุบทบาทของแต่ละคนในดีลการขาย: หากมีผู้ที่สำคัญหรือมีบทบาทสำคัญ เช่น Key Person, Decision Maker, Influencer หรือผู้มีอำนาจในการตัดสินใจ ให้ระบุให้ชัดเจน
2. Highlight ประเด็นสำคัญ
• สรุปประเด็นสำคัญ ที่ลูกค้าได้พูดถึง โดยเน้นไปที่สิ่งที่สำคัญต่อการตัดสินใจซื้อ เช่น ความต้องการ, ปัญหาหรือคำถามที่เกิดขึ้น
• หากมีการพูดถึง คู่แข่ง หรือ บริษัทอื่น ระบุไว้ให้ชัดเจน
• ถ้ามีคำพูดสำคัญจากผู้ใด ให้ระบุชื่อผู้พูดและเวลาในการพูด เช่น "เชอรี่ (เวลา 00:05): โปรแกรม HRM สามารถรองรับหลายภาษา"
• หากพบประเด็นที่เกี่ยวข้องกับ BANT (Budget, Authority, Need, Timing) ให้สรุปเป็นประเด็นที่ชัดเจน
3. ข้อสรุปเพิ่มเติม
• หากมี ข้อกังวล (Concern) หรือประเด็นที่ยังไม่ได้ข้อสรุปจากการประชุม ให้ระบุเพิ่มเติม เช่น "ต้องการการพัฒนาฟีเจอร์เพิ่มเติม"
• ระบุข้อสรุปที่สำคัญ ที่สามารถดำเนินการได้ในขั้นถัดไป โดยแนะนำการติดตามหรือดำเนินการของทีมงานใน next action plan
• หากยังไม่สามารถสรุปได้ให้ทำ remark ว่าต้องดำเนินการต่อในขั้นถัดไป
4. บรรยากาศโดยรวมในมีตติ้ง
• ประเมินบรรยากาศ โดยรวมของการประชุมจากผู้เข้าร่วมประชุม โดยเฉพาะผู้ที่มีบทบาทสำคัญ เช่น Key Person และ Decision Maker
  o Mood: ระบุเป็น Positive, Neutral หรือ Negative
  o ประเมินการมีส่วนร่วม เช่น การถามคำถาม, การแสดงความสนใจ, หรือการตอบสนองต่อข้อมูลจากทีมงาน
  o หากมีการเปลี่ยนแปลงในบรรยากาศ ให้ระบุช่วงเวลาและสาเหตุ
  o ระบุท่าทีของผู้มีบทบาทสำคัญ โดยเฉพาะ Decision Maker
5. Next Action Plan
• สรุป Next Action Plan โดยระบุ: Task - Owner - Due Date (ถ้ามี) - Priority (ถ้ามี)
• หากยังไม่กำหนด Due Date ให้ระบุเป็น TBD และให้ชัดเจนว่าต้องทำอะไรบ้าง
`;

/** ===== Example direct-run (optional) =====
 * ให้พฤติกรรมเหมือนไฟล์อีกตัว — รันตรงได้ แต่โดยปกติจะ import ไปใช้
 *
 * ใช้ env:
 *   OPENAI_API_KEY=xxxx
 * ตัวอย่าง:
 *   npx ts-node src/summarize/meeting_summarizer.ts recordings/4374A463-3D05-465B-AD0F-E3EE8F2F6AA1/transcripts_by_speaker.json
 */

if (require.main === module) {
  (async () => {
    try {
      const input = process.argv[2];
      if (!input) throw new Error("ใส่ path ของ transcripts_by_speaker.json เป็นอาร์กิวเมนต์ตัวแรก");
      const summarizer = createMeetingSummarizer();
      summarizer.on("progress", (p) => console.log("progress:", p));
      summarizer.on("error", (e) => console.error("error:", e));
      summarizer.on("done", (d) => console.log("done:", d.out));

      await summarizer.start({ inputJson: input });
    } catch (e) {
      console.error(e);
      process.exit(1);
    }
  })();
}
