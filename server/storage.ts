import { type User, type InsertUser, type Download, type InsertDownload } from "@shared/schema";
import { randomUUID } from "crypto";

// modify the interface with any CRUD methods
// you might need

export interface IStorage {
  // User methods
  getUser(id: string): Promise<User | undefined>;
  getUserByUsername(username: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  
  // Download methods
  createDownload(download: InsertDownload): Promise<Download>;
  getDownload(id: string): Promise<Download | undefined>;
  getDownloads(): Promise<Download[]>;
  updateDownload(id: string, updates: Partial<Download>): Promise<Download | undefined>;
  deleteDownload(id: string): Promise<boolean>;
  clearDownloads(): Promise<void>;
}

export class MemStorage implements IStorage {
  private users: Map<string, User>;
  private downloads: Map<string, Download>;

  constructor() {
    this.users = new Map();
    this.downloads = new Map();
  }

  // User methods
  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async getUserByUsername(username: string): Promise<User | undefined> {
    return Array.from(this.users.values()).find(
      (user) => user.username === username,
    );
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const id = randomUUID();
    const user: User = { ...insertUser, id };
    this.users.set(id, user);
    return user;
  }

  // Download methods
  async createDownload(insertDownload: InsertDownload): Promise<Download> {
    const id = randomUUID();
    const now = new Date();
    const download: Download = { 
      ...insertDownload,
      thumbnail: insertDownload.thumbnail || null,
      duration: insertDownload.duration || null,
      views: insertDownload.views || null,
      author: insertDownload.author || null,
      filePath: insertDownload.filePath || null,
      fileSize: insertDownload.fileSize || null,
      itag: insertDownload.itag || null,
      id,
      createdAt: now,
      updatedAt: now
    };
    this.downloads.set(id, download);
    return download;
  }

  async getDownload(id: string): Promise<Download | undefined> {
    return this.downloads.get(id);
  }

  async getDownloads(): Promise<Download[]> {
    return Array.from(this.downloads.values()).sort(
      (a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime()
    );
  }

  async updateDownload(id: string, updates: Partial<Download>): Promise<Download | undefined> {
    const existing = this.downloads.get(id);
    if (!existing) return undefined;
    
    const updated: Download = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };
    this.downloads.set(id, updated);
    return updated;
  }

  async deleteDownload(id: string): Promise<boolean> {
    return this.downloads.delete(id);
  }

  async clearDownloads(): Promise<void> {
    this.downloads.clear();
  }
}

export const storage = new MemStorage();
