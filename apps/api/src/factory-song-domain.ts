import { z } from 'zod';

export const songMode=z.enum(['viking-anthem','viking-rap-duet']);
export const musicProfileSchema=z.object({
  id:z.string().trim().min(3).max(60),
  label:z.string().trim().min(3).max(100),
  bpm:z.number().int().min(55).max(145),
  meter:z.string().trim().min(2).max(12)
}).strict();
export const songPackageSchema=z.object({
  title:z.string().trim().min(3).max(100),
  concept:z.string().trim().min(30).max(1800),
  lyrics:z.string().trim().min(200).max(12000),
  sunoPrompt:z.string().trim().min(30).max(1000),
  artworkPrompt:z.string().trim().min(30).max(2000),
  // Older saved songs do not have this field. Every newly generated package does.
  musicProfile:musicProfileSchema.optional()
}).strict();
export type SongPackage=z.infer<typeof songPackageSchema>;
