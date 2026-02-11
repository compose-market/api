/**
 * Structured Logging Utility - Enterprise Grade
 * 
 * Provides JSON-formatted logs for CloudWatch with:
 * - Log level filtering (debug, info, warn, error)
 * - AWS Request ID tracking
 * - Timestamp ISO formatting
 * - Structured metadata support
 * - Lambda environment detection
 * 
 * Environment Variables:
 * - LOG_LEVEL: debug | info | warn | error (default: info)
 * - NODE_ENV: production | development
 * - AWS_REQUEST_ID: Set automatically by Lambda runtime
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: Record<LogLevel, number> = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
};

const currentLevel = (process.env.LOG_LEVEL as LogLevel) || "info";
const isProduction = process.env.NODE_ENV === "production";
const awsRequestId = process.env.AWS_REQUEST_ID;
const awsLambdaFunctionName = process.env.AWS_LAMBDA_FUNCTION_NAME;

/**
 * Core logging function
 */
function log(
    level: LogLevel,
    message: string,
    meta?: Record<string, unknown>,
    error?: Error
): void {
    const levelValue = LOG_LEVELS[level];
    const currentValue = LOG_LEVELS[currentLevel];

    if (levelValue < currentValue) {
        return; // Skip logging if below current level
    }

    const timestamp = new Date().toISOString();
    
    const logEntry: Record<string, unknown> = {
        timestamp,
        level: level.toUpperCase(),
        message,
        ...meta,
    };

    // Add Lambda context if available
    if (awsRequestId) {
        logEntry.awsRequestId = awsRequestId;
    }
    
    if (awsLambdaFunctionName) {
        logEntry.lambdaFunction = awsLambdaFunctionName;
    }

    // Add error details if provided
    if (error) {
        logEntry.errorName = error.name;
        logEntry.errorMessage = error.message;
        logEntry.errorStack = isProduction ? undefined : error.stack;
    }

    const logString = JSON.stringify(logEntry);

    // Output to appropriate console method
    switch (level) {
        case "error":
            console.error(logString);
            break;
        case "warn":
            console.warn(logString);
            break;
        case "debug":
            console.debug(logString);
            break;
        default:
            console.log(logString);
    }
}

/**
 * Logger interface with typed methods
 */
export const logger = {
    /**
     * Debug level logging - detailed information for development
     */
    debug: (message: string, meta?: Record<string, unknown>) => {
        log("debug", message, meta);
    },

    /**
     * Info level logging - general operational information
     */
    info: (message: string, meta?: Record<string, unknown>) => {
        log("info", message, meta);
    },

    /**
     * Warn level logging - potential issues that don't stop operation
     */
    warn: (message: string, meta?: Record<string, unknown>, error?: Error) => {
        log("warn", message, meta, error);
    },

    /**
     * Error level logging - actual errors that need attention
     */
    error: (message: string, meta?: Record<string, unknown>, error?: Error) => {
        log("error", message, meta, error);
    },

    /**
     * Create a child logger with prefixed context
     */
    child: (prefix: string) => ({
        debug: (message: string, meta?: Record<string, unknown>) => {
            log("debug", `[${prefix}] ${message}`, meta);
        },
        info: (message: string, meta?: Record<string, unknown>) => {
            log("info", `[${prefix}] ${message}`, meta);
        },
        warn: (message: string, meta?: Record<string, unknown>, error?: Error) => {
            log("warn", `[${prefix}] ${message}`, meta, error);
        },
        error: (message: string, meta?: Record<string, unknown>, error?: Error) => {
            log("error", `[${prefix}] ${message}`, meta, error);
        },
    }),

    /**
     * Get current log level
     */
    getLevel: (): LogLevel => currentLevel,

    /**
     * Check if a level is enabled
     */
    isEnabled: (level: LogLevel): boolean => {
        return LOG_LEVELS[level] >= LOG_LEVELS[currentLevel];
    },
};

// Default export for convenience
export default logger;
