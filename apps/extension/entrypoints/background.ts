// The coordinator is shared with the currently exercised reading runtime. It
// keeps the message and durable-job protocol stable while the side panel
// migrates incrementally to React.
import '../background.js';

export default defineBackground(() => {
  // Listeners are registered by the imported coordinator above.
});
