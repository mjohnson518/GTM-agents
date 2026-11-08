// GTM-agents: the runtime module's public surface: the tool dispatcher.
export { executeToolCall } from "./dispatcher.ts";
export type {
  CallOptions,
  DispatchResult,
  DispatcherDeps,
  PreCallCheck,
  ToolCall,
  ToolHandler,
  ToolHandlerContext,
  ToolHandlerResult,
  ToolSession,
} from "./dispatcher.ts";
