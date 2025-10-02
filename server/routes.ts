import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import ytdl from "@distube/ytdl-core";
import { z } from "zod";
import { insertDownloadSchema, videoInfoSchema, downloadRequestSchema } from "@shared/schema";
import path from "path";
import fs from "fs";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";

// Create downloads directory if it doesn't exist
const downloadsDir = path.join(process.cwd(), "downloads");
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
}

// Configure ffmpeg
if (ffmpegStatic) {
  ffmpeg.setFfmpegPath(ffmpegStatic);
}

// Validation schemas
const urlSchema = z.object({
  url: z.string().url(),
});

export async function registerRoutes(app: Express): Promise<Server> {
  // Video information endpoint
  app.post("/api/video-info", async (req: Request, res: Response) => {
    try {
      const { url } = urlSchema.parse(req.body);
      
      // Validate YouTube URL
      if (!ytdl.validateURL(url)) {
        return res.status(400).json({ 
          message: "Invalid YouTube URL. Please provide a valid YouTube video link." 
        });
      }

      const videoId = ytdl.getVideoID(url);
      const info = await ytdl.getInfo(videoId);
      
      console.log('DEBUG: Total formats found:', info.formats.length);
      
      if (info.formats.length > 0) {
        console.log('DEBUG: First format properties:', Object.keys(info.formats[0]));
        console.log('DEBUG: Sample format:', JSON.stringify(info.formats[0], null, 2));
      }

      // Get available containers and qualities
      const containers = Array.from(new Set(info.formats.map(f => f.container)));
      console.log('DEBUG: Available containers:', containers);
      
      const videoQualities = info.formats
        .filter(f => f.hasVideo && f.qualityLabel)
        .map(f => f.qualityLabel);
      console.log('DEBUG: All video qualities found:', videoQualities);
      
      // Get both progressive formats (video + audio) and video-only formats
      const progressiveVideoFormats = info.formats.filter(f => f.hasVideo && f.hasAudio && f.qualityLabel);
      const videoOnlyFormats = info.formats.filter(f => f.hasVideo && !f.hasAudio && f.qualityLabel);
      const audioFormats = info.formats.filter(f => f.hasAudio && !f.hasVideo);
      
      console.log('DEBUG: Progressive video formats found:', progressiveVideoFormats.length);
      console.log('DEBUG: Video-only formats found:', videoOnlyFormats.length);
      console.log('DEBUG: Audio formats found:', audioFormats.length);
      
      // Process video formats - support both progressive and mux
      // Dynamically enumerate all available quality labels
      const allVideoQualities = Array.from(new Set([...progressiveVideoFormats, ...videoOnlyFormats]
        .filter(f => f.qualityLabel)
        .map(f => f.qualityLabel!)))
        .sort((a, b) => {
          // Sort by resolution priority (4K > 1440p > 1080p > 720p > etc.)
          const getResolutionPriority = (quality: string) => {
            if (quality.includes('2160p') || quality.includes('4K')) return 9000;
            if (quality.includes('1440p') || quality.includes('2K')) return 8000;
            if (quality.includes('1080p')) return 7000;
            if (quality.includes('720p')) return 6000;
            if (quality.includes('480p')) return 5000;
            if (quality.includes('360p')) return 4000;
            if (quality.includes('240p')) return 3000;
            if (quality.includes('144p')) return 2000;
            return 1000;
          };
          return getResolutionPriority(b) - getResolutionPriority(a);
        });

      console.log('Available video qualities:', allVideoQualities);
      
      const processedVideoFormats: any[] = [];
      
      for (const qualityLabel of allVideoQualities) {
        // First try to find progressive format (video + audio combined)
        const progressiveFormat = progressiveVideoFormats.find(f => 
          f.qualityLabel === qualityLabel && f.container === 'mp4'
        ) || progressiveVideoFormats.find(f => 
          f.qualityLabel === qualityLabel && f.container === 'webm'
        ) || progressiveVideoFormats.find(f => 
          f.qualityLabel === qualityLabel
        );
        
        if (progressiveFormat) {
          // Add progressive format
          const container = progressiveFormat.container || 'mp4';
          
          processedVideoFormats.push({
            itag: progressiveFormat.itag.toString(),
            quality: qualityLabel,
            format: container,
            container,
            type: 'video' as const,
            hasAudio: true,
            downloadMethod: 'progressive',
            fileSize: progressiveFormat.contentLength ? 
              `${Math.round(parseInt(progressiveFormat.contentLength) / (1024 * 1024))} MB` : 
              undefined,
          });
        } else {
          // If no progressive format, try to create mux option with video-only + audio
          const videoOnlyFormat = videoOnlyFormats.find(f => 
            f.qualityLabel === qualityLabel && f.container === 'mp4'
          ) || videoOnlyFormats.find(f => 
            f.qualityLabel === qualityLabel && f.container === 'webm'
          ) || videoOnlyFormats.find(f => 
            f.qualityLabel === qualityLabel
          );
          
          if (videoOnlyFormat && audioFormats.length > 0) {
            // Find compatible audio format - prefer same container family
            const videoContainer = videoOnlyFormat.container || 'mp4';
            const videoCodec = videoOnlyFormat.videoCodec || '';
            
            // Choose audio based on video container/codec compatibility
            let audioFormat;
            let outputContainer;
            
            if (videoContainer === 'mp4' || videoCodec.startsWith('avc1')) {
              // For MP4/H.264, strictly prefer AAC audio to avoid transcoding
              audioFormat = audioFormats
                .filter(f => f.audioCodec && f.audioCodec.includes('mp4a'))
                .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
              
              if (!audioFormat) {
                // If no AAC audio, check if video has WebM alternative
                const webmVideoFormat = videoOnlyFormats.find(f => 
                  f.qualityLabel === qualityLabel && f.container === 'webm'
                );
                if (webmVideoFormat) {
                  // Use WebM video + WebM audio to avoid transcoding
                  audioFormat = audioFormats
                    .filter(f => f.container === 'webm' || (f.audioCodec && f.audioCodec.includes('opus')))
                    .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
                  outputContainer = 'webm';
                } else {
                  // Skip this quality to avoid transcoding
                  continue;
                }
              } else {
                outputContainer = 'mp4';
              }
            } else if (videoContainer === 'webm') {
              // For WebM, prefer WebM/Opus audio
              audioFormat = audioFormats
                .filter(f => f.container === 'webm' || (f.audioCodec && f.audioCodec.includes('opus')))
                .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0];
              
              if (!audioFormat) {
                // Skip this quality to avoid transcoding
                continue;
              }
              outputContainer = 'webm';
            } else {
              // Unknown container - skip to avoid issues
              continue;
            }
            
            if (audioFormat) {
              const videoSize = videoOnlyFormat.contentLength ? parseInt(videoOnlyFormat.contentLength) : 0;
              const audioSize = audioFormat.contentLength ? parseInt(audioFormat.contentLength) : 0;
              const totalSize = videoSize + audioSize;
              
              processedVideoFormats.push({
                quality: qualityLabel,
                format: outputContainer,
                container: outputContainer,
                type: 'video' as const,
                hasAudio: true,
                downloadMethod: 'mux',
                videoItag: videoOnlyFormat.itag.toString(),
                audioItag: audioFormat.itag.toString(),
                fileSize: totalSize > 0 ? 
                  `${Math.round(totalSize / (1024 * 1024))} MB` : 
                  undefined,
              });
            }
          }
        }
      }

      // Process audio formats (MP3 equivalent)
      // Get unique audio formats first, then create quality labels based on actual bitrates
      const uniqueAudioFormats = audioFormats
        .filter((format, index, arr) => 
          arr.findIndex(f => f.itag === format.itag) === index
        )
        .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0)); // Sort by bitrate descending
      
      const processedAudioFormats = uniqueAudioFormats
        .map((format, index) => {
          if (format) {
            const actualBitrate = format.audioBitrate || 128;
            
            // Generate quality label based on actual bitrate
            let qualityLabel: string;
            if (actualBitrate >= 250) {
              qualityLabel = '320kbps';
            } else if (actualBitrate >= 160) {
              qualityLabel = '192kbps';
            } else {
              qualityLabel = '128kbps';
            }
            
            return {
              itag: format.itag.toString(),
              quality: `${qualityLabel} (mp3)`,
              format: 'mp3',
              container: 'mp3',
              type: 'audio' as const,
              fileSize: format.contentLength ? 
                `${Math.round(parseInt(format.contentLength) / (1024 * 1024))} MB` : 
                undefined,
            };
          }
          return null;
        })
        .filter(Boolean);

      const allFormats = [...processedVideoFormats, ...processedAudioFormats];

      const videoInfo = {
        videoId,
        title: info.videoDetails.title,
        thumbnail: info.videoDetails.thumbnails?.[0]?.url,
        duration: formatDuration(parseInt(info.videoDetails.lengthSeconds)),
        views: formatViews(parseInt(info.videoDetails.viewCount)),
        author: info.videoDetails.author.name,
        formats: allFormats,
      };

      res.json(videoInfo);
    } catch (error: any) {
      console.error("Error getting video info:", error);
      res.status(500).json({ 
        message: error.message || "Failed to fetch video information" 
      });
    }
  });

  // Start download endpoint
  app.post("/api/download", async (req: Request, res: Response) => {
    try {
      const downloadData = downloadRequestSchema.parse(req.body);
      
      // Create download record
      const download = await storage.createDownload({
        ...downloadData,
        status: "pending",
        progress: 0,
      });

      res.json(download);

      // Start download process in background
      if (downloadData.downloadMethod === 'progressive') {
        startDownload(download.id, downloadData.videoId, downloadData.itag, downloadData.format);
      } else {
        // For mux downloads, pass both video and audio itags
        startMuxDownload(download.id, downloadData.videoId, downloadData.videoItag, downloadData.audioItag, downloadData.format);
      }
      
    } catch (error: any) {
      console.error("Error starting download:", error);
      res.status(500).json({ 
        message: error.message || "Failed to start download" 
      });
    }
  });

  // Get download status
  app.get("/api/download/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const download = await storage.getDownload(id);
      
      if (!download) {
        return res.status(404).json({ message: "Download not found" });
      }

      res.json(download);
    } catch (error: any) {
      console.error("Error getting download:", error);
      res.status(500).json({ 
        message: error.message || "Failed to get download status" 
      });
    }
  });

  // Get all downloads
  app.get("/api/downloads", async (req: Request, res: Response) => {
    try {
      const downloads = await storage.getDownloads();
      res.json(downloads);
    } catch (error: any) {
      console.error("Error getting downloads:", error);
      res.status(500).json({ 
        message: error.message || "Failed to get downloads" 
      });
    }
  });

  // Download completed file to user's device
  app.get("/api/download/:id/file", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const download = await storage.getDownload(id);
      
      if (!download) {
        return res.status(404).json({ message: "Download not found" });
      }

      if (download.status !== "completed" || !download.filePath) {
        return res.status(400).json({ message: "File not ready for download" });
      }

      if (!fs.existsSync(download.filePath)) {
        return res.status(404).json({ message: "File not found on server" });
      }

      // Set appropriate headers for file download
      const filename = `${download.title.replace(/[^a-zA-Z0-9]/g, '_')}.${download.format}`;
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      
      // Stream file to user
      const fileStream = fs.createReadStream(download.filePath);
      fileStream.pipe(res);
      
      fileStream.on('error', (error) => {
        console.error('Error streaming file:', error);
        if (!res.headersSent) {
          res.status(500).json({ message: "Error downloading file" });
        }
      });

    } catch (error: any) {
      console.error("Error downloading file:", error);
      if (!res.headersSent) {
        res.status(500).json({ 
          message: error.message || "Failed to download file" 
        });
      }
    }
  });

  // Cancel/delete specific download
  app.delete("/api/download/:id", async (req: Request, res: Response) => {
    try {
      const { id } = req.params;
      const download = await storage.getDownload(id);
      
      if (!download) {
        return res.status(404).json({ message: "Download not found" });
      }

      // Delete file if it exists
      if (download.filePath && fs.existsSync(download.filePath)) {
        fs.unlinkSync(download.filePath);
      }

      await storage.deleteDownload(id);
      res.json({ message: "Download cancelled and removed" });
    } catch (error: any) {
      console.error("Error deleting download:", error);
      res.status(500).json({ 
        message: error.message || "Failed to delete download" 
      });
    }
  });

  // Clear all downloads
  app.delete("/api/downloads", async (req: Request, res: Response) => {
    try {
      const downloads = await storage.getDownloads();
      
      // Delete all files
      for (const download of downloads) {
        if (download.filePath && fs.existsSync(download.filePath)) {
          fs.unlinkSync(download.filePath);
        }
      }

      await storage.clearDownloads();
      res.json({ message: "All downloads cleared" });
    } catch (error: any) {
      console.error("Error clearing downloads:", error);
      res.status(500).json({ 
        message: error.message || "Failed to clear downloads" 
      });
    }
  });


  const httpServer = createServer(app);
  return httpServer;
}

// Background download processing
async function startDownload(downloadId: string, videoId: string, itag: string, format: string) {
  try {
    await storage.updateDownload(downloadId, { status: "downloading" });

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const filename = `${downloadId}.${format}`;
    const filepath = path.join(downloadsDir, filename);

    // Check if this is an audio format (webm, m4a, opus, mp3, etc.)
    const audioFormats = ['webm', 'm4a', 'opus', 'mp4a', 'aac', 'mp3'];
    if (audioFormats.includes(format)) {
      // For audio, find the exact format by the requested itag
      const info = await ytdl.getInfo(videoId);
      let audioFormat = info.formats.find(f => 
        f.itag.toString() === itag && f.hasAudio && !f.hasVideo
      );
      
      // If exact itag not found, fallback to highest bitrate audio
      if (!audioFormat) {
        console.log(`Requested audio itag ${itag} not found, attempting fallback to highest bitrate audio`);
        audioFormat = info.formats
          .filter(f => f.hasAudio && !f.hasVideo)
          .sort((a, b) => (b.audioBitrate || 0) - (a.audioBitrate || 0))[0]; // highest bitrate first
      }
      
      // Final fallback: any audio format
      if (!audioFormat) {
        audioFormat = info.formats.find(f => f.hasAudio && !f.hasVideo);
      }
      
      if (!audioFormat) {
        throw new Error('No audio format available');
      }
      
      // Update filename to match actual format if different from requested
      const actualContainer = audioFormat.container || format;
      const actualFilename = `${downloadId}.${actualContainer}`;
      const actualFilepath = path.join(downloadsDir, actualFilename);
      
      console.log(`Downloading audio with itag ${audioFormat.itag}, container: ${actualContainer}, requested: ${format}`);
      
      // If MP3 is requested, download in original format first then convert
      const isMP3Conversion = format === 'mp3';
      const tempFilename = isMP3Conversion ? `${downloadId}_temp.${actualContainer}` : actualFilename;
      const tempFilepath = isMP3Conversion ? path.join(downloadsDir, tempFilename) : actualFilepath;
      const finalFilename = isMP3Conversion ? `${downloadId}.mp3` : actualFilename;
      const finalFilepath = isMP3Conversion ? path.join(downloadsDir, finalFilename) : actualFilepath;

      const stream = ytdl(videoUrl, { 
        filter: (format) => format.itag === audioFormat.itag,
        quality: 'highestaudio'
      });

      const writeStream = fs.createWriteStream(tempFilepath);
      stream.pipe(writeStream);

      let totalBytes = 0;
      let downloadedBytes = 0;

      stream.on('progress', (chunkLength, downloaded, total) => {
        totalBytes = total;
        downloadedBytes = downloaded;
        const progress = isMP3Conversion ? Math.round((downloaded / total) * 70) : Math.round((downloaded / total) * 100);
        
        storage.updateDownload(downloadId, { 
          progress,
          fileSize: `${Math.round(total / (1024 * 1024))} MB`
        });
      });

      // Handle writeStream errors
      writeStream.on('error', async (error) => {
        console.error('Error writing audio file:', error);
        // Clean up temp file if exists
        if (isMP3Conversion && fs.existsSync(tempFilepath)) {
          fs.unlinkSync(tempFilepath);
        }
        await storage.updateDownload(downloadId, { 
          status: "failed",
          progress: 0
        });
      });

      // Wait for writeStream to finish, not just stream to end
      writeStream.on('finish', async () => {
        if (isMP3Conversion) {
          // Convert to MP3 using ffmpeg
          try {
            await storage.updateDownload(downloadId, { progress: 75 });
            console.log('Converting audio to MP3...');
            
            await new Promise<void>((resolve, reject) => {
              ffmpeg(tempFilepath)
                .toFormat('mp3')
                .audioBitrate(audioFormat.audioBitrate || 192)
                .output(finalFilepath)
                .on('start', (commandLine) => {
                  console.log('FFmpeg command:', commandLine);
                })
                .on('progress', (progress) => {
                  const conversionProgress = Math.round(75 + (progress.percent || 0) * 0.25);
                  storage.updateDownload(downloadId, { progress: conversionProgress });
                })
                .on('end', () => {
                  console.log('MP3 conversion completed');
                  // Clean up temp file
                  if (fs.existsSync(tempFilepath)) {
                    fs.unlinkSync(tempFilepath);
                  }
                  resolve();
                })
                .on('error', (error) => {
                  console.error('Error converting to MP3:', error);
                  reject(error);
                })
                .run();
            });
            
            // Get final file size
            const finalSize = fs.statSync(finalFilepath).size;
            await storage.updateDownload(downloadId, { 
              status: "completed",
              progress: 100,
              filePath: finalFilepath,
              fileSize: `${Math.round(finalSize / (1024 * 1024))} MB`
            });
          } catch (conversionError) {
            console.error('Error during MP3 conversion:', conversionError);
            // Clean up temp file
            if (fs.existsSync(tempFilepath)) {
              fs.unlinkSync(tempFilepath);
            }
            await storage.updateDownload(downloadId, { 
              status: "failed",
              progress: 0
            });
          }
        } else {
          await storage.updateDownload(downloadId, { 
            status: "completed",
            progress: 100,
            filePath: finalFilepath,
            fileSize: `${Math.round(totalBytes / (1024 * 1024))} MB`
          });
        }
      });

      stream.on('error', async (error) => {
        console.error('Error in download process:', error);
        // Clean up temp file if exists
        if (isMP3Conversion && fs.existsSync(tempFilepath)) {
          fs.unlinkSync(tempFilepath);
        }
        await storage.updateDownload(downloadId, { 
          status: "failed",
          progress: 0
        });
      });

    } else {
      // For video, download the requested format (progressive or video-only)
      const info = await ytdl.getInfo(videoId);
      
      // Find the requested itag (can be progressive or video-only)
      let selectedFormat = info.formats.find(f => 
        f.itag.toString() === itag && f.hasVideo
      );
      
      if (!selectedFormat) {
        throw new Error(`No video format available with itag ${itag}`);
      }
      
      console.log(`Downloading video with itag ${selectedFormat.itag}, quality: ${selectedFormat.qualityLabel}, hasAudio: ${selectedFormat.hasAudio}`);
      
      const stream = ytdl(videoUrl, { 
        filter: (format) => format.itag === selectedFormat.itag,
        quality: 'highest'
      });

      const writeStream = fs.createWriteStream(filepath);
      stream.pipe(writeStream);

      let totalBytes = 0;

      stream.on('progress', (chunkLength, downloaded, total) => {
        totalBytes = total;
        const progress = Math.round((downloaded / total) * 100);
        
        storage.updateDownload(downloadId, { 
          progress,
          fileSize: `${Math.round(total / (1024 * 1024))} MB`
        });
      });

      stream.on('end', async () => {
        await storage.updateDownload(downloadId, { 
          status: "completed",
          progress: 100,
          filePath: filepath,
          fileSize: `${Math.round(totalBytes / (1024 * 1024))} MB`
        });
      });

      stream.on('error', async (error) => {
        console.error('Error in download process:', error);
        await storage.updateDownload(downloadId, { 
          status: "failed",
          progress: 0
        });
      });
    }

  } catch (error: any) {
    console.error('Error in download process:', error);
    await storage.updateDownload(downloadId, { 
      status: "failed",
      progress: 0
    });
  }
}

// Background mux download processing  
async function startMuxDownload(downloadId: string, videoId: string, videoItag: string, audioItag: string, clientFormat: string) {
  try {
    await storage.updateDownload(downloadId, { status: "downloading" });

    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const tempDir = path.join(downloadsDir, 'temp');
    
    // Ensure temp directory exists
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    // Get format info to determine safe output container
    const info = await ytdl.getInfo(videoId);
    const videoFormat = info.formats.find(f => f.itag.toString() === videoItag);
    const audioFormat = info.formats.find(f => f.itag.toString() === audioItag);

    if (!videoFormat || !audioFormat) {
      throw new Error(`Video or audio format not found for itags ${videoItag}, ${audioItag}`);
    }

    // Re-derive output container based on actual format compatibility
    let outputContainer = 'mp4'; // default
    const videoCodec = videoFormat.videoCodec || '';
    const audioCodec = audioFormat.audioCodec || '';

    if (videoCodec.startsWith('avc1') && audioCodec.includes('mp4a')) {
      outputContainer = 'mp4';
    } else if (videoFormat.container === 'webm' && audioFormat.container === 'webm') {
      outputContainer = 'webm';
    } else if (audioCodec.includes('opus') && videoCodec.startsWith('vp9')) {
      outputContainer = 'webm';
    } else {
      // If incompatible, prefer mp4 but warn
      console.warn(`Potentially incompatible formats: video=${videoCodec} audio=${audioCodec}, using mp4`);
      outputContainer = 'mp4';
    }

    const videoTempPath = path.join(tempDir, `${downloadId}_video.temp`);
    const audioTempPath = path.join(tempDir, `${downloadId}_audio.temp`);
    const finalFilename = `${downloadId}.${outputContainer}`;
    const finalFilepath = path.join(downloadsDir, finalFilename);

    console.log(`Starting mux download - Video itag: ${videoItag} (${videoCodec}), Audio itag: ${audioItag} (${audioCodec}), Output: ${outputContainer}`);

    // Download video and audio streams in parallel
    let videoDownloaded = false;
    let audioDownloaded = false;
    let videoBytes = 0;
    let audioBytes = 0;
    let totalVideoBytes = 0;
    let totalAudioBytes = 0;

    const updateProgress = () => {
      if (totalVideoBytes > 0 && totalAudioBytes > 0) {
        const videoProgress = videoBytes / totalVideoBytes;
        const audioProgress = audioBytes / totalAudioBytes;
        // Progress: 0-80% for downloads, 81-100% for muxing
        const overallProgress = Math.round(((videoProgress + audioProgress) / 2) * 80);
        storage.updateDownload(downloadId, { 
          progress: overallProgress,
          fileSize: `${Math.round((totalVideoBytes + totalAudioBytes) / (1024 * 1024))} MB`
        });
      }
    };

    // Download video stream
    const videoPromise = new Promise<void>((resolve, reject) => {
      const videoStream = ytdl(videoUrl, { 
        filter: (format) => format.itag.toString() === videoItag,
        quality: 'highest'
      });

      const videoWriteStream = fs.createWriteStream(videoTempPath);
      videoStream.pipe(videoWriteStream);

      videoStream.on('progress', (chunkLength, downloaded, total) => {
        videoBytes = downloaded;
        totalVideoBytes = total;
        updateProgress();
      });

      // Wait for write stream to finish, not just read stream to end
      videoWriteStream.on('finish', () => {
        videoDownloaded = true;
        console.log('Video stream download completed');
        resolve();
      });

      videoStream.on('error', (error) => {
        console.error('Error downloading video stream:', error);
        reject(error);
      });

      videoWriteStream.on('error', (error) => {
        console.error('Error writing video stream to file:', error);
        reject(error);
      });
    });

    // Download audio stream
    const audioPromise = new Promise<void>((resolve, reject) => {
      const audioStream = ytdl(videoUrl, { 
        filter: (format) => format.itag.toString() === audioItag,
        quality: 'highestaudio'
      });

      const audioWriteStream = fs.createWriteStream(audioTempPath);
      audioStream.pipe(audioWriteStream);

      audioStream.on('progress', (chunkLength, downloaded, total) => {
        audioBytes = downloaded;
        totalAudioBytes = total;
        updateProgress();
      });

      // Wait for write stream to finish, not just read stream to end
      audioWriteStream.on('finish', () => {
        audioDownloaded = true;
        console.log('Audio stream download completed');
        resolve();
      });

      audioStream.on('error', (error) => {
        console.error('Error downloading audio stream:', error);
        reject(error);
      });

      audioWriteStream.on('error', (error) => {
        console.error('Error writing audio stream to file:', error);
        reject(error);
      });
    });

    // Wait for both downloads to complete
    await Promise.all([videoPromise, audioPromise]);

    console.log('Both streams downloaded, starting mux process');
    
    // Update progress to muxing phase
    await storage.updateDownload(downloadId, { progress: 81 });

    // Mux video and audio using ffmpeg
    await new Promise<void>((resolve, reject) => {
      ffmpeg()
        .input(videoTempPath)
        .input(audioTempPath)
        .outputOptions([
          '-c copy',              // Stream copy (no re-encoding)
          '-map 0:v:0',          // Map first video stream from first input
          '-map 1:a:0',          // Map first audio stream from second input
          '-shortest'            // Finish when shortest stream ends
        ])
        .output(finalFilepath)
        .on('start', (commandLine) => {
          console.log('FFmpeg command:', commandLine);
        })
        .on('progress', (progress) => {
          // Map ffmpeg progress to 81-99%
          const muxProgress = Math.round(81 + (progress.percent || 0) * 0.18);
          storage.updateDownload(downloadId, { progress: muxProgress });
        })
        .on('end', () => {
          console.log('Mux process completed');
          resolve();
        })
        .on('error', (error) => {
          console.error('Error during mux process:', error);
          reject(error);
        })
        .run();
    });

    // Clean up temporary files
    try {
      if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
      if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath);
    } catch (cleanupError) {
      console.warn('Error cleaning up temp files:', cleanupError);
    }

    // Update download as completed
    const finalSize = fs.statSync(finalFilepath).size;
    await storage.updateDownload(downloadId, { 
      status: "completed",
      progress: 100,
      filePath: finalFilepath,
      fileSize: `${Math.round(finalSize / (1024 * 1024))} MB`
    });

    console.log('Mux download completed successfully');

  } catch (error: any) {
    console.error('Error in mux download process:', error);
    
    // Clean up any temporary files and partial output on error
    const tempDir = path.join(downloadsDir, 'temp');
    const videoTempPath = path.join(tempDir, `${downloadId}_video.temp`);
    const audioTempPath = path.join(tempDir, `${downloadId}_audio.temp`);
    
    try {
      if (fs.existsSync(videoTempPath)) fs.unlinkSync(videoTempPath);
      if (fs.existsSync(audioTempPath)) fs.unlinkSync(audioTempPath);
      
      // Clean up any partially written final files (try both possible containers)
      const mp4Path = path.join(downloadsDir, `${downloadId}.mp4`);
      const webmPath = path.join(downloadsDir, `${downloadId}.webm`);
      if (fs.existsSync(mp4Path)) fs.unlinkSync(mp4Path);
      if (fs.existsSync(webmPath)) fs.unlinkSync(webmPath);
    } catch (cleanupError) {
      console.warn('Error cleaning up files after error:', cleanupError);
    }

    await storage.updateDownload(downloadId, { 
      status: "failed",
      progress: 0
    });
  }
}

// Helper functions
function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  }
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

function formatViews(viewCount: number): string {
  if (viewCount >= 1000000000) {
    return `${(viewCount / 1000000000).toFixed(1)}B views`;
  } else if (viewCount >= 1000000) {
    return `${(viewCount / 1000000).toFixed(1)}M views`;
  } else if (viewCount >= 1000) {
    return `${(viewCount / 1000).toFixed(1)}K views`;
  }
  return `${viewCount} views`;
}