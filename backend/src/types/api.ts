export type ApiGatewayProxyEvent = {
  httpMethod?: string;
  rawPath?: string;
  path?: string;
  rawQueryString?: string;
  queryStringParameters?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  requestContext?: {
    requestId?: string;
    http?: {
      method?: string;
    };
  };
  body?: string | null;
};

export type ApiGatewayProxyResult = {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
};

export type LambdaExecutionContext = {
  getRemainingTimeInMillis?: () => number;
};
