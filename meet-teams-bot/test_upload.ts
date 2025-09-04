/**
 * test_upload.ts
 *
 * Usage:
 *   npx ts-node test_upload.ts --file ./data/output.wav --meeting 50A3B197-B662-4463-A0CF-A75FE32D382D --expires 1800 --bucket meeting-bot
 *
 * ENV ตัวอย่าง (R2):
 *   export AWS_ACCESS_KEY_ID=xxxx
 *   export AWS_SECRET_ACCESS_KEY=xxxx
 *   export S3_ENDPOINT=<ACCOUNT_ID>.r2.cloudflarestorage.com
 *   export S3_REGION=auto
 *   export S3_FORCE_PATHSTYLE=true
 *   export AWS_S3_BUCKET=meeting-bot
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { S3Uploader } from './src/utils/S3Uploader_new'; // <-- ปรับ path ให้ตรงโปรเจกต์คุณ

function arg(flag: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

// UUID v4 fallback (ใช้ crypto.randomUUID ถ้ามี ไม่งั้นใช้ randomBytes)
function makeUUID(): string {
  const anyCrypto = crypto as any;
  if (typeof anyCrypto.randomUUID === 'function') {
    return anyCrypto.randomUUID();
  }
  const b = crypto.randomBytes(16);
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = b.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function usage(): never {
  console.log(`
Usage:
  npx ts-node test_upload.ts --file <localPath> [--meeting <uuid>] [--expires <seconds>] [--bucket <name>]

Example:
  npx ts-node test_upload.ts --file ./data/output.wav --meeting 50A3B197-B662-4463-A0CF-A75FE32D382D --expires 1800 --bucket meeting-bot
`);
  process.exit(1);
}

(async () => {
  const localPath = arg('--file') || arg('-f');
  if (!localPath) {
    console.error('ERROR: ต้องใส่ --file <path ถึงไฟล์ท้องถิ่น>');
    usage();
  }
  if (!fs.existsSync(localPath!)) {
    console.error(`ERROR: ไม่พบไฟล์: ${localPath}`);
    process.exit(1);
  }

  const meetingId = arg('--meeting') || process.env.MEETING_ID || makeUUID();
  // const meetingId = "d03cf5a0-9bf0-4633-a6ef-5285de528615";
  const expiresIn = Math.max(60, parseInt(arg('--expires') || process.env.PRESIGN_EXPIRES || '1800', 10) || 1800);
  const bucket = arg('--bucket') || process.env.AWS_S3_BUCKET || process.env.S3_BUCKET;

  if (!bucket) {
    console.error('ERROR: ไม่ระบุ bucket. ใส่ --bucket หรือเซ็ต ENV AWS_S3_BUCKET');
    process.exit(1);
  }

  const fileName = path.basename(localPath!);
  const ext = path.extname(fileName).toLowerCase();
  const isAudio = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.opus'].includes(ext);

  // key = results/meetings/<meetingId>/<fileName>
  const RESULTS_PREFIX = process.env.AWS_S3_RESULTS_PREFIX || 'results';
  const key = `${meetingId}/${fileName}`.replace(/^\/+/, '');

  const uploader = S3Uploader.getInstance();

  try {
    console.log('Uploading:', localPath, '->', `s3://${bucket}/${key}`);
    const uploadedUrl = await uploader.uploadFile(localPath!, bucket, key, undefined, isAudio);

    console.log('Creating presigned GET URL...');
    const presigned = await uploader.createPresignedGetUrl(bucket, key, expiresIn);

    console.log('\n✅ สำเร็จ!');
    console.log('Bucket :', bucket);
    console.log('Key    :', key);
    console.log('Object :', `s3://${bucket}/${key}`);
    console.log('URL    :', uploadedUrl, '(อาจใช้ได้ถ้าเป็น public/มี S3_PUBLIC_HOST)');
    console.log('Download (presigned):');
    console.log(presigned, '\n'); // คัดลอกไปเปิดในเบราว์เซอร์ได้เลย
  } catch (e: any) {
    console.error('❌ Upload test failed:', e?.message || e);
    process.exit(1);
  }
})();
