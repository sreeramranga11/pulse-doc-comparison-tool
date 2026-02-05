export { createApp } from "./src/app.js";

import { createApp } from "./src/app.js";

const { app, config } = createApp();

app.listen(config.port, () => {
  console.log(`Pulse comparison tool running on http://localhost:${config.port}`);
  if (config.debugEnabled) {
    console.log("Debug logging is enabled. Set PULSE_DEBUG_LOGS=false to disable.");
  }
});

