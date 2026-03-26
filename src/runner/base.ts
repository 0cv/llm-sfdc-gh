import { logger } from "../utils/logger.js";

/**
 * Assert that environment variables are set; exit with error if any are missing.
 */
export function requireEnv(...vars: string[]): void {
  const missing = vars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    logger.error(`Missing required environment variables: ${missing.join(", ")}`);
    process.exit(1);
  }
}
