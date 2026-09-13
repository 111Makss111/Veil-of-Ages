import { z } from 'zod';

export const songMode=z.enum(['viking-anthem','viking-rap-duet']);
export const songPackageSchema=z.object({
  title:z.string().trim().min(3).max(100),
  concept:z.string().trim().min(30).max(1800),
  lyrics:z.string().trim().min(200).max(12000),
  sunoPrompt:z.string().trim().min(30).max(1000),
  artworkPrompt:z.string().trim().min(30).max(2000)
}).strict();
export type SongPackage=z.infer<typeof songPackageSchema>;
