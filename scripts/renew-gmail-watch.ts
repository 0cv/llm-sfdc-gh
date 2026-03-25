/**
 * Manually renew the Gmail Pub/Sub watch subscription.
 * In production this is handled automatically by Cloud Scheduler.
 *
 * Usage: npm run renew-watch
 */

import "dotenv/config";
import { renewGmailWatch } from "../src/gmail/watch.js";

const result = await renewGmailWatch();
console.log("Watch renewed successfully:");
console.log(`  historyId:  ${result.historyId}`);
console.log(`  expiration: ${result.expiration}`);
