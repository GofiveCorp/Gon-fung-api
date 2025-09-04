
import { spawn } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { GLOBAL } from "../singleton";
import 'dotenv/config';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { lookup as mimeLookup } from "mime-types";

// ==============================
// Environment / Defaults
// ==============================

/**
 * Examples:
 *  - AWS:      S3_ENDPOINT not required (let SDK resolve). Set S3_REGION (e.g., "ap-southeast-1").
 *  - Scaleway: S3_ENDPOINT=s3.fr-par.scw.cloud, S3_REGION=fr-par
 *  - R2:       S3_ENDPOINT=<ACCOUNT_ID>.r2.cloudflarestorage.com, S3_REGION=auto
 *
 * If using Cloudflare R2 public buckets, you may set S3_PUBLIC_HOST to "<bucket>.<ACCOUNT_ID>.r2.dev"
 * and we will compose https URLs against that host.
 *
 */
const S3_ENDPOINT = process.env.S3_ENDPOINT || ""; // host (no scheme) e.g. "s3.fr-par.scw.cloud" or "<ACCOUNT_ID>.r2.cloudflarestorage.com"
console.log("S3_ENDPOINT =", S3_ENDPOINT);
const S3_REGION = process.env.S3_REGION || "auto";
const S3_FORCE_PATHSTYLE = (process.env.S3_FORCE_PATHSTYLE || "").toLowerCase() === "true";
const S3_PUBLIC_HOST = process.env.S3_PUBLIC_HOST || ""; // optional, e.g. "<bucket>.<ACCOUNT_ID>.r2.dev" (we'll replace <bucket>)

// When true, CLI path will try to append "--acl public-read" (not supported by R2; we auto-skip for R2).
const S3_USE_ACL_PUBLIC_READ = (process.env.S3_USE_ACL_PUBLIC_READ || "").toLowerCase() === "true";

// Default bucket to use with helper s3cp(local, s3path, s3_args)
const DEFAULT_S3_BUCKET = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET || "";

// Reuse a single S3 client
function makeS3Client(): S3Client {
  const endpoint = S3_ENDPOINT ? `https://${S3_ENDPOINT}` : undefined;
  // On R2 & some S3-compatible endpoints we need path-style
  const needsPathStyle =
    S3_FORCE_PATHSTYLE ||
    (!!S3_ENDPOINT && /r2\.cloudflarestorage\.com$/i.test(S3_ENDPOINT));

  return new S3Client({
    region: S3_REGION,
    endpoint,
    forcePathStyle: needsPathStyle,
    // credentials resolved from env/instanceRole automatically
  });
}

const s3 = makeS3Client();

function isR2(): boolean {
  return !!S3_ENDPOINT && /r2\.cloudflarestorage\.com$/i.test(S3_ENDPOINT);
}

function guessContentType(filePathOrKey: string, fallback = "application/octet-stream") {
  const ext = path.extname(filePathOrKey || "");
  const mt = (mimeLookup(ext) || "").toString();
  return mt || fallback;
}

// ==============================
// S3Uploader
// ==============================

let instance: S3Uploader | null = null;

export class S3Uploader {
  private constructor() {}

  static getInstance(): S3Uploader {
    if (!instance) instance = new S3Uploader();
    return instance;
  }

  // ------------------------------
  // Utilities
  // ------------------------------

  private async checkFileExists(filePath: string) {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size <= 0) {
        throw new Error(`File not ready: ${filePath}`);
      }
    } catch (e: any) {
      throw new Error(`File not found: ${filePath} (${e?.message || e})`);
    }
  }

  private getS3Args(s3Args?: string[]): string[] {
    // Merge: explicit args > env S3_ARGS
    if (s3Args && s3Args.length > 0) return s3Args;
    if (process.env.S3_ARGS) {
      // split by spaces (simple), allow quoted? keep simple for now
      return process.env.S3_ARGS.split(" ").filter(Boolean);
    }
    // Provide sensible defaults for known providers (optional)
    const args: string[] = [];
    if (S3_ENDPOINT) {
      args.push("--endpoint-url", `${S3_ENDPOINT}`);
    }
    if (S3_REGION) {
      args.push("--region", S3_REGION);
    }
    return args;
  }

  private composeHttpsUrl(bucket: string, key: string): string {
    // Try to compose a https URL for convenience. This may not always work with private buckets.
    if (S3_PUBLIC_HOST) {
      const host = S3_PUBLIC_HOST.replace("<bucket>", bucket);
      return `https://${host}/${key}`;
    }
    if (S3_ENDPOINT) {
      // Virtual-hosted style: https://<bucket>.<endpoint>/<key>
      return `${bucket}.${S3_ENDPOINT}/${key}`;
    }
    // Generic S3-style URL unknown; fall back to s3://
    return `s3://${bucket}/${key}`;
  }

  // ------------------------------
  // CLI Upload (aws s3 cp) with SDK fallback
  // ------------------------------

  /**
   * Upload with AWS CLI first (if available), then fall back to SDK if CLI fails
   * NOTE: For R2, we auto-remove any ACL usage.
   */
  public async uploadFile(
    filePath: string,
    bucketName: string,
    s3Key: string,
    s3Args?: string[],
    isAudio: boolean = false
  ): Promise<string> {
    // if (GLOBAL.isServerless?.()) {
    //   console.log("Skipping S3 upload - serverless mode");
    //   return "";
    // }

    await this.checkFileExists(filePath);

    // Build CLI args
    let fullArgs = this.getS3Args(s3Args);
    fullArgs = [
      ...fullArgs,
      "s3",
      "cp",
      filePath,
      `s3://${bucketName}/${s3Key}`,
    ];

    // Append ACL if asked AND not R2
    if (S3_USE_ACL_PUBLIC_READ && !isR2()) {
      fullArgs.push("--acl", "public-read");
    }

    console.log("🔍 S3 upload command:", "aws", fullArgs.join(" "));

    try {
      const url = await new Promise<string>((resolve, reject) => {
        const awsProcess = spawn("aws", fullArgs);
        let output = "";
        let errorOutput = "";

        awsProcess.stdout.on("data", (data) => {
          output += data.toString();
        });

        awsProcess.stderr.on("data", (data) => {
          errorOutput += data.toString();
          console.error("S3 upload error:", data.toString().trim());
        });

        awsProcess.on("error", (error) => {
          reject(new Error(`AWS CLI process failed to start: ${error.message}`));
        });

        awsProcess.on("close", (code) => {
          if (code === 0) {
            resolve(this.composeHttpsUrl(bucketName, s3Key));
          } else {
            const msg = `S3 upload failed (${code}): ${errorOutput || output}`;
            reject(new Error(msg));
          }
        });
      });
      return url;
    } catch (err: any) {
      // Typical for Alpine/arm images: "rosetta error: failed to open elf ..."
      console.error("CLI failed, fallback to SDK:", err?.message || err);
      return this.uploadFileSDK(filePath, bucketName, s3Key, isAudio);
    }
  }

  private async uploadFileSDK(
    filePath: string,
    bucket: string,
    key: string,
    isAudio = false
  ): Promise<string> {
    // เดา content-type เริ่มต้น
  let contentType = isAudio ? "audio/wav" : guessContentType(filePath) || "application/octet-stream";

  // บังคับสำหรับ .json ให้เป็น UTF-8 เสมอ
  if (key.toLowerCase().endsWith(".json")) {
    contentType = "application/json; charset=utf-8";
  }

  // ถ้าเป็น text/* แต่ยังไม่มี charset ให้เติมเป็น utf-8
  if (/^text\/[a-z0-9.+-]+/i.test(contentType) && !/charset=/i.test(contentType)) {
    contentType += "; charset=utf-8";
  }
    const body = fs.readFileSync(filePath);
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        // Do NOT set ACL on R2 (not supported).
      })
    );
    return this.composeHttpsUrl(bucket, key);
  }

  // ------------------------------
  // Convenience wrapper with default bucket
  // ------------------------------
  public async uploadToDefaultBucket(
    filePath: string,
    s3Key: string,
    s3Args?: string[],
    isAudio: boolean = false
  ): Promise<string> {
    if (!DEFAULT_S3_BUCKET) {
      throw new Error("DEFAULT_S3_BUCKET is not set");
    }
    return this.uploadFile(filePath, DEFAULT_S3_BUCKET, s3Key, s3Args, isAudio);
  }

  // ------------------------------
  // Presigned URLs
  // ------------------------------

  /** Presigned GET (download) */
  public async createPresignedGetUrl(
    bucketName: string,
    s3Key: string,
    expiresIn = 3600
  ): Promise<string> {
    const cmd = new GetObjectCommand({ Bucket: bucketName, Key: s3Key });
    return getSignedUrl(s3, cmd, { expiresIn });
  }

  /** Presigned PUT (upload from client) */
  public async createPresignedPutUrl(
    bucketName: string,
    s3Key: string,
    contentType?: string,
    expiresIn = 600
  ): Promise<{ url: string; method: "PUT"; headers: Record<string, string> }> {
    const ct = contentType || guessContentType(s3Key);
    const cmd = new PutObjectCommand({
      Bucket: bucketName,
      Key: s3Key,
      ContentType: ct,
    });
    const url = await getSignedUrl(s3, cmd, { expiresIn });
    return { url, method: "PUT", headers: { "Content-Type": ct } };
  }
}

// ------------------------------
// Utility export (same signature you used earlier)
// ------------------------------
export const s3cp = (
  local: string,
  s3path: string,
  s3_args: string[]
): Promise<string> =>
  S3Uploader.getInstance().uploadToDefaultBucket(local, s3path, s3_args);
