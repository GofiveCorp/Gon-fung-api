/**
 * presign_get.ts
 *
 * วิธีใช้:
 *   npx ts-node presign_get.ts "s3://meeting-bot/CFAF224F-0A8E-42DB-894C-2C45AC8DCAB4/output.wav" --expires 1800
 *
 * ENV ตัวอย่าง (Cloudflare R2):
 *   export AWS_ACCESS_KEY_ID=xxxx
 *   export AWS_SECRET_ACCESS_KEY=xxxx
 *   export S3_ENDPOINT=<ACCOUNT_ID>.r2.cloudflarestorage.com   # <-- ไม่มี https://
 *   export S3_REGION=auto
 *   export S3_FORCE_PATHSTYLE=true
 *
 * หมายเหตุ: สคริปต์นี้สร้าง Presigned **GET** URL (ไว้โหลดไฟล์)
 */

import { S3Uploader } from './src/utils/S3Uploader_new'; // <-- ปรับ path ให้ตรงของคุณ

function usage(): never {
  console.log(`
Usage:
  npx ts-node presign_get.ts "s3://<bucket>/<key>" [--expires <seconds>]

Example:
  npx ts-node presign_get.ts "s3://meeting-bot/CFAF224F-0A8E-42DB-894C-2C45AC8DCAB4/output.wav" --expires 1800
  npx ts-node presign_get.ts "s3://meeting-bot/B86D7C75-3376-470F-BC4B-CF98365CA695/meeting_summary.txt" --expires 1800
  npx ts-node presign_get.ts "s3://meeting-bot/B86D7C75-3376-470F-BC4B-CF98365CA695/transcripts_by_speaker.json" --expires 1800  
  `);
  process.exit(1);
}

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function parseS3Uri(uri?: string): { bucket: string; key: string } {
  if (!uri) usage();
  const m = uri.match(/^s3:\/\/([^/]+)\/(.+)$/i);
  if (!m) {
    throw new Error(`รูปแบบลิงก์ไม่ถูกต้อง: ${uri}\nตัวอย่างที่ถูก: s3://bucket/path/to/file.ext`);
  }
  return { bucket: m[1], key: m[2] };
}

(async () => {
  const s3uri = process.argv[2];
  if (!s3uri) usage();

  const { bucket, key } = parseS3Uri(s3uri);
  const expiresIn = Math.max(60, parseInt(arg("--expires") || "1800", 10) || 1800);

  try {
    const uploader = S3Uploader.getInstance();
    const url = await uploader.createPresignedGetUrl(bucket, key, expiresIn);

    console.log("✅ Presigned GET URL:");
    console.log(url);
    console.log("\n(คัดลอกลิงก์นี้ไปวางในเบราว์เซอร์หรือใช้กับ fetch/curl ได้ทันที)");
  } catch (e: any) {
    console.error("❌ สร้าง Presigned URL ไม่สำเร็จ:", e?.message || e);
    process.exit(1);
  }
})();
