import { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

export const STORAGE_LIMIT = 8_000_000_000;
export const INPUT_LIMIT = 6_000_000_000; // Keep 2 GB inside our cap available for finished videos.
export interface ObjectStore {
  usage(): Promise<number>;
  put(key: string, data: Buffer, type: string): Promise<void>;
  get(key: string, max: number): Promise<Buffer>;
}
export function createObjectStore(): ObjectStore | null {
  const { R2_ACCOUNT_ID: account, R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey, R2_BUCKET: bucket } = process.env;
  if (!account || !accessKeyId || !secretAccessKey || !bucket) return null;
  if (!/^[a-f0-9]{32}$/i.test(account) || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) return null;
  const client = new S3Client({ region: 'auto', endpoint: `https://${account}.r2.cloudflarestorage.com`, credentials: { accessKeyId, secretAccessKey }, maxAttempts: 1 });
  return {
    async usage() {
      let token: string | undefined, bytes = 0;
      // Count the entire bucket, not only our prefix. Never interpret a failed scan as zero.
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }), { abortSignal: AbortSignal.timeout(20000) });
        bytes += (page.Contents ?? []).reduce((sum, o) => sum + (o.Size ?? 0), 0);
        if (page.IsTruncated && !page.NextContinuationToken) throw new Error('Incomplete storage scan');
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      return bytes;
    },
    async put(key, data, type) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: data, ContentType: type, ContentLength: data.length }), { abortSignal: AbortSignal.timeout(60000) });
    },
    async get(key, max) {
      const result = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: AbortSignal.timeout(60000) });
      if (!result.Body || result.ContentLength === undefined || result.ContentLength > max) throw new Error('Invalid stored file size');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of result.Body as AsyncIterable<Uint8Array>) {
        size += chunk.length;
        if (size > max) throw new Error('Stored file exceeds limit');
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    }
  };
}
