// src/buffer/index.ts
import loggerService from "@/logger";
import configService from "@/config";
import { SimpleMessage } from "@/types";
// Import ScorerService later when it's created
// import scorerService from '@/scorer';

type FlushCallback = (
  channelId: string,
  messages: SimpleMessage[],
) => Promise<void>;

class BufferQueueService {
  private static instance: BufferQueueService;

  // Map<channelId, Message[]>
  private buffer = new Map<string, SimpleMessage[]>();
  // Map<channelId, NodeJS.Timeout>
  private timers = new Map<string, NodeJS.Timeout>();

  private bufferSize: number = 10; // Default
  private bufferTimeWindowMs: number = 5000; // Default
  private flushCallback: FlushCallback | null = null; // Callback to trigger scoring/evaluation

  private constructor() {
    try {
      const config = configService.getConfig();
      this.bufferSize = config.bufferSize;
      this.bufferTimeWindowMs = config.bufferTimeWindowMs;
      loggerService.logger.info("BufferQueueService initialized.");
      // TODO: Add listener for config changes to update bufferSize/bufferTimeWindowMs?
    } catch (error) {
      loggerService.logger.error(
        "Failed to initialize BufferQueueService with config. Using defaults.",
        error,
      );
    }
  }

  /**
   * @description Gets the singleton instance of the BufferQueueService.
   * @returns {BufferQueueService} The singleton instance.
   */
  public static getInstance(): BufferQueueService {
    if (!BufferQueueService.instance) {
      BufferQueueService.instance = new BufferQueueService();
    }
    return BufferQueueService.instance;
  }

  /**
   * @description Sets the callback function to be executed when the buffer is flushed.
   * This will typically be the function that triggers the ScorerService.
   * @param callback The async function to call with channelId and messages.
   */
  public setFlushCallback(callback: FlushCallback): void {
    this.flushCallback = callback;
    loggerService.logger.info("Buffer flush callback set.");
  }

  /**
   * @description Adds a message to the buffer for a specific channel.
   * Triggers flushing if size threshold is met. Resets the flush timer.
   * @param message The SimpleMessage object to add.
   */
  public addMessage(message: SimpleMessage): void {
    const { channelId } = message;

    if (!this.flushCallback) {
      loggerService.logger.warn(
        "Flush callback not set in BufferQueueService. Messages will accumulate.",
      );
      // Optionally, still buffer but log a warning
    }

    let channelBuffer = this.buffer.get(channelId);
    if (!channelBuffer) {
      channelBuffer = [];
      this.buffer.set(channelId, channelBuffer);
    }

    channelBuffer.push(message);
    loggerService.logger.debug(
      `Message ${message.id}, content: ${message.content} added to buffer for channel ${channelId}. Size: ${channelBuffer.length}`,
    );

    // Check if buffer size threshold is reached
    if (channelBuffer.length >= this.bufferSize) {
      loggerService.logger.info(
        `Buffer size threshold reached for channel ${channelId}. Flushing immediately.`,
      );
      this.flush(channelId); // Flush immediately, this also clears the timer
    } else {
      // Reset the timer for this channel
      this.resetTimer(channelId);
    }
  }

  /**
   * @description Resets the flush timer for a given channel.
   * @param channelId The ID of the channel.
   */
  private resetTimer(channelId: string): void {
    // Clear existing timer if any
    const existingTimer = this.timers.get(channelId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Set a new timer
    const newTimer = setTimeout(() => {
      loggerService.logger.info(
        `Buffer time window expired for channel ${channelId}. Flushing.`,
      );
      this.flush(channelId);
    }, this.bufferTimeWindowMs);

    this.timers.set(channelId, newTimer);
  }

  /**
   * @description Flushes the buffer for a specific channel.
   * Clears the buffer and timer for that channel and calls the flush callback.
   * @param channelId The ID of the channel to flush.
   */
  private async flush(channelId: string): Promise<void> {
    const channelBuffer = this.buffer.get(channelId);
    const timer = this.timers.get(channelId);

    // Clear timer first
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(channelId);
    }

    if (channelBuffer && channelBuffer.length > 0) {
      // Get messages and clear buffer *before* async callback
      const messagesToFlush = [...channelBuffer];
      this.buffer.set(channelId, []); // Clear buffer immediately
      loggerService.logger.info(
        `Flushing ${messagesToFlush.length} messages for channel ${channelId}.`,
      );

      if (this.flushCallback) {
        try {
          await this.flushCallback(channelId, messagesToFlush);
        } catch (error) {
          loggerService.logger.error(
            `Error executing flush callback for channel ${channelId}:`,
            error,
          );
          // Decide how to handle errors - retry? discard?
          // For now, just log the error. The buffer is already cleared.
        }
      } else {
        loggerService.logger.warn(
          `No flush callback set. Flushed messages for channel ${channelId} were discarded.`,
        );
      }
    } else {
      // Buffer might be empty if flushed manually or by size limit just before timer fires
      loggerService.logger.debug(
        `Flush called for channel ${channelId}, but buffer was empty.`,
      );
      this.buffer.delete(channelId); // Clean up empty buffer entry
    }
  }

  /**
   * @description Manually flushes all buffers for all channels.
   * Useful for graceful shutdown.
   */
  public async flushAll(): Promise<void> {
    loggerService.logger.info(
      "Manual flushAll triggered for BufferQueueService.",
    );
    const channelIds = Array.from(this.buffer.keys());
    const flushPromises: Promise<void>[] = [];
    for (const channelId of channelIds) {
      // Use the internal flush method which handles timer clearing etc.
      flushPromises.push(this.flush(channelId));
    }
    await Promise.all(flushPromises);
    loggerService.logger.info("Finished flushing all buffers.");
  }
}

// Export the singleton instance directly
const bufferQueueService = BufferQueueService.getInstance();
export default bufferQueueService;
export { BufferQueueService }; // Export the class type if needed
