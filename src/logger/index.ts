// src/logger/index.ts
import pino, { Logger } from "pino";
import { AppConfig } from "@/types";

class LoggerService {
  private static instance: LoggerService;
  public readonly logger: Logger; // Make logger instance public readonly

  private constructor() {
    // Initialize with a default level, will be updated by ConfigService
    const defaultLogLevel: AppConfig["logLevel"] = "info";
    this.logger = pino({
      level: process.env.LOG_LEVEL || defaultLogLevel,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          ignore: "pid,hostname",
          translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        },
      },
    });
    this.logger.info("LoggerService initialized.");
  }

  /**
   * @description Gets the singleton instance of the LoggerService.
   * @returns {LoggerService} The singleton instance.
   */
  public static getInstance(): LoggerService {
    if (!LoggerService.instance) {
      LoggerService.instance = new LoggerService();
    }
    return LoggerService.instance;
  }

  /**
   * @description Updates the log level of the logger instance.
   * @param level {AppConfig['logLevel']} The new log level.
   */
  public updateLogLevel(level: AppConfig["logLevel"]): void {
    // Only update if the level is actually different
    if (this.logger.level !== level) {
      this.logger.level = level;
      // Use the logger instance itself to log the update
      this.logger.info(`Log level updated to: ${level}`);
    }
  }
}

// Export the singleton instance directly
const loggerService = LoggerService.getInstance();
export default loggerService; // Export the instance
export { LoggerService }; // Export the class type if needed elsewhere
