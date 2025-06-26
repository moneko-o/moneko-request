import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

import {
  type GenericResponse,
  HttpRegExp,
  parseUrl,
  type RequestOption as BasicOption,
} from './basic.js';
export * from './basic.js';

const abortControllers: Map<string, AbortController> = new Map();

export interface InterceptorRequestType extends RequestOption {
  url: string;
}
export interface HttpInterceptorType {
  /** 请求拦截器 */
  request?(option: InterceptorRequestType): RequestOption | void;
  /** 响应拦截器 */
  response?(response: XMLHttpRequest['response'], xhr: IncomingMessage): void;
  /** HTTP状态错误 */
  httpError?(err: Error): void;
}

export interface HttpRequestExtendType {
  /**
   * 是否在请求中携带跨域凭据（如 Cookies）
   * @default "include"
   */
  credentials?: RequestOption['credentials'];
  /**
   * 请求的 URL 前缀
   * 用于在基础 URL 之外追加额外的路径前缀
   */
  prefix?: RequestOption['prefix'];
  /**
   * 自定义请求头
   */
  headers?: RequestOption['headers'];
  /** 拦截器配置 */
  interceptor?: HttpInterceptorType;
}

const globalExtendOptions: HttpRequestExtendType = {};

interface RequestOption
  extends Omit<BasicOption, 'onProgress'>,
    Omit<https.RequestOptions, 'method' | 'headers'> {
  onProgress?(progress: number, total: number): void;
}
export function request<T = GenericResponse>(url: string, opt: RequestOption = {}): Promise<T> {
  const options = Object.assign({}, globalExtendOptions, opt);
  const interceptors = globalExtendOptions.interceptor;
  let uri = url;

  // 拦截器
  if (interceptors && interceptors.request) {
    const modifiedOptions = interceptors.request(Object.assign({ url }, options));

    if (modifiedOptions) {
      Object.assign(options, modifiedOptions);
    }
  }
  const isHttpUlr = HttpRegExp.test(url);
  // 添加请求前缀
  let prefix = isHttpUlr ? '' : globalExtendOptions.prefix || '';
  const {
    method = 'GET',
    headers,
    onProgress,
    responseType,
    abortId,
    data,
    params: _params,
    prefix: _prefix,
    ...other
  } = options;

  if (_prefix) {
    prefix = _prefix;
  }

  if (_params && (Object.keys(_params).length || _params instanceof URLSearchParams)) {
    const params = new URLSearchParams(_params as Record<string, string>);

    uri = `${url}?${params.toString()}`;
  }
  const URI = isHttpUlr ? url : parseUrl([prefix, uri].filter(Boolean).join('/'));
  const urlObj = new URL(URI);
  const isHttps = urlObj.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise<T>((resolve, reject) => {
    const req = lib.request(
      URI,
      {
        hostname: urlObj.hostname,
        port: urlObj.port || (isHttps ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method,
        headers: headers,
        ...other,
      },
      (res) => {
        if (res.statusCode === 302 || res.statusCode === 301) {
          const redirectUrl = res.headers.location;

          if (redirectUrl) {
            return request(url, opt);
          }
        }
        const chunks: Buffer[] = [];
        const total = parseInt(res.headers['content-length'] || '0'); // 文件总长度
        let progress = 0;

        res.on('data', (chunk) => {
          progress += chunk.length;
          chunks.push(chunk);
          if (onProgress) {
            onProgress(progress, total);
          }
        });
        res.on('end', () => {
          const rawData = Buffer.concat(chunks);
          let parsedData: T;
          const type = responseType === void 0 ? 'json' : responseType;

          try {
            switch (type) {
              case 'json':
                parsedData = JSON.parse(rawData.toString()) as T;
                break;
              case 'text':
                parsedData = rawData.toString() as T;
                break;
              default:
                parsedData = rawData as unknown as T;
            }
          } catch (e) {
            return reject(e);
          }
          if (interceptors && interceptors.response) {
            interceptors.response(parsedData, res);
          }
          resolve(parsedData as T);
        });
      },
    );

    req.on('error', (err) => {
      if (interceptors && interceptors.httpError) {
        interceptors.httpError(err);
      }
      reject(err);
    });

    if (abortId) {
      const controller = new AbortController();

      abortControllers.set(abortId, controller);
      controller.signal.addEventListener('abort', () => req.destroy());
    }
    if (data !== null && !['undefined', 'string'].includes(typeof data)) {
      req.write(typeof data === 'object' ? JSON.stringify(data) : data);
    }
    req.end();
  });
}

export function cancelRequest(abortId: string): void {
  const controller = abortControllers.get(abortId);

  if (controller) {
    controller.abort();
    abortControllers.delete(abortId);
  }
}

export function extend(opt: HttpRequestExtendType): typeof request {
  Object.assign(globalExtendOptions, opt);
  return request;
}
