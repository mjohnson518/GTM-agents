// GTM-agents: a recording operator channel for the security suite.
import type { OperatorChannel } from "@gtm-agents/core/ports";

export interface FakeOperator {
  channel: OperatorChannel;
  sent: string[];
  /** Number of upcoming notify calls that throw. */
  failNext: number;
}

export function fakeOperator(): FakeOperator {
  const state: FakeOperator = { sent: [], failNext: 0, channel: undefined as unknown as OperatorChannel };
  state.channel = {
    name: "fake",
    notify: (message) => {
      if (state.failNext > 0) {
        state.failNext -= 1;
        return Promise.reject(new Error("operator channel unavailable"));
      }
      state.sent.push(message.text);
      return Promise.resolve({ messageId: String(state.sent.length) });
    },
    requestApproval: () => Promise.resolve({ messageId: "approval" }),
    editMessage: () => Promise.resolve(),
    acknowledgeCallback: () => Promise.resolve(),
    parseUpdate: () => Promise.resolve({ type: "ignored", reason: "test" }),
    registerWebhook: () => Promise.resolve(),
  };
  return state;
}
