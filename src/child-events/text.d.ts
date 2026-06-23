import type { Message } from "@earendil-works/pi-ai";
import type { ForkResult } from "../core/types.js";

export function getFinalAssistantText(messages: Message[] | undefined): string;
export function getResultSummaryText(result: Partial<ForkResult> | undefined): string;
