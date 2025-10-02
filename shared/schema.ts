import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, json } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  username: text("username").notNull().unique(),
  password: text("password").notNull(),
});

export const downloads = pgTable("downloads", {
  id: varchar("id").primaryKey().default(sql`gen_random_uuid()`),
  videoId: text("video_id").notNull(),
  title: text("title").notNull(),
  thumbnail: text("thumbnail"),
  duration: text("duration"),
  views: text("views"),
  author: text("author"),
  quality: text("quality").notNull(),
  format: text("format").notNull(),
  status: text("status").notNull(), // pending, downloading, completed, failed
  progress: integer("progress").default(0),
  filePath: text("file_path"),
  fileSize: text("file_size"),
  itag: text("itag"),
  downloadMethod: text("download_method").notNull().default("progressive"), // progressive, mux
  videoItag: text("video_itag"), // for mux downloads
  audioItag: text("audio_itag"), // for mux downloads
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

export const insertUserSchema = createInsertSchema(users).pick({
  username: true,
  password: true,
});

export const insertDownloadSchema = createInsertSchema(downloads).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Schema for download requests from client (only required fields)
// Union type to support both progressive and mux downloads
export const progressiveDownloadRequestSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  thumbnail: z.string().optional(),
  duration: z.string().optional(),
  views: z.string().optional(),
  author: z.string().optional(),
  quality: z.string(),
  format: z.string(),
  itag: z.string(),
  downloadMethod: z.literal("progressive"),
});

export const muxDownloadRequestSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  thumbnail: z.string().optional(),
  duration: z.string().optional(),
  views: z.string().optional(),
  author: z.string().optional(),
  quality: z.string(),
  format: z.string(),
  videoItag: z.string(),
  audioItag: z.string(),
  downloadMethod: z.literal("mux"),
});

export const downloadRequestSchema = z.discriminatedUnion('downloadMethod', [
  progressiveDownloadRequestSchema,
  muxDownloadRequestSchema,
]);

export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof users.$inferSelect;
export type InsertDownload = z.infer<typeof insertDownloadSchema>;
export type Download = typeof downloads.$inferSelect;
export type DownloadRequest = z.infer<typeof downloadRequestSchema>;

// Video info types for API responses
export const videoInfoSchema = z.object({
  videoId: z.string(),
  title: z.string(),
  thumbnail: z.string().optional(),
  duration: z.string().optional(),
  views: z.string().optional(),
  author: z.string().optional(),
  formats: z.array(z.object({
    itag: z.string().optional(),
    quality: z.string(),
    format: z.string(),
    container: z.string().optional(),
    type: z.enum(['video', 'audio']),
    fileSize: z.string().optional(),
    hasAudio: z.boolean().optional(),
    downloadMethod: z.enum(['progressive', 'mux']).optional(),
    videoItag: z.string().optional(),
    audioItag: z.string().optional(),
  })),
});

export type VideoInfo = z.infer<typeof videoInfoSchema>;
