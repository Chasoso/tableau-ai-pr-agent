declare module "@strands-agents/sdk" {
  import type { ZodTypeAny } from "zod";

  export type JSONPrimitive = string | number | boolean | null;
  export type JSONValue =
    | JSONPrimitive
    | { [key: string]: JSONValue }
    | JSONValue[];

  export type InvokableTool<TInput = unknown, TReturn = JSONValue> = {
    name: string;
    description?: string;
    inputSchema?: ZodTypeAny;
    callback?: (input: TInput) => Promise<TReturn> | TReturn;
  };

  export type ZodToolConfig<
    TInput extends ZodTypeAny = ZodTypeAny,
    TReturn extends JSONValue = JSONValue,
  > = {
    name: string;
    description: string;
    inputSchema: TInput;
    callback: (input: TInput["_output"]) => Promise<TReturn> | TReturn;
  };

  export function tool<
    TInput extends ZodTypeAny,
    TReturn extends JSONValue = JSONValue,
  >(
    config: ZodToolConfig<TInput, TReturn>,
  ): InvokableTool<TInput["_output"], TReturn>;

  export class BedrockModel {
    constructor(config: Record<string, unknown>);
  }

  export class Agent {
    constructor(config: Record<string, unknown>);
    invoke(input: string): Promise<{ structuredOutput?: unknown }>;
  }
}
