// 文件名：src/utils/webdavUtils.ts
import { R2Object, R2Bucket, R2ListOptions } from '@cloudflare/workers-types';
import { WebDAVProps } from '../types';

export interface ListedResource {
  key: string;
  name: string;
  isDirectory: boolean;
  size?: number;
  uploaded?: Date;
  etag?: string;
  contentType?: string;
}

export function make_resource_path(request: Request): string {
  const url = new URL(request.url);
  // Remove leading slash and decode URI components
  let pathname = decodeURIComponent(url.pathname.slice(1));
  return pathname;
}

/**
 * 修复后的目录列出函数：
 * 1. 规范化 prefix，确保目录以 '/' 结尾
 * 2. 完整处理 result.delimitedPrefixes（通过父文件夹路径上传文件时生成的虚拟文件夹）
 * 3. 完整处理 result.objects（包含显式创建的文件夹对象和普通文件）
 * 4. 修复 while 循环条件，处理多页游标 (cursor)
 */
export async function listDirectory(bucket: R2Bucket, prefix: string): Promise<ListedResource[]> {
  // 规范化 prefix：非空时必须以 '/' 结尾，才能正确匹配子目录与文件
  const normalizedPrefix = prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
  const options: R2ListOptions = {
    prefix: normalizedPrefix,
    delimiter: '/',
  };

  const items: ListedResource[] = [];
  const seenDirectories = new Set<string>();

  let truncated = true;
  let cursor: string | undefined = undefined;

  while (truncated) {
    const result = await bucket.list(cursor ? { ...options, cursor } : options);

    // 1. 处理由子文件路径隐式生成的父目录 (delimitedPrefixes)
    if (result.delimitedPrefixes) {
      for (const dirPrefix of result.delimitedPrefixes) {
        if (dirPrefix === normalizedPrefix) continue;
        const cleanPath = dirPrefix.endsWith('/') ? dirPrefix.slice(0, -1) : dirPrefix;
        const dirName = cleanPath.split('/').pop() || cleanPath;
        if (!seenDirectories.has(dirPrefix)) {
          seenDirectories.add(dirPrefix);
          items.push({
            key: dirPrefix,
            name: dirName,
            isDirectory: true,
          });
        }
      }
    }

    // 2. 处理当前层级的对象 (objects)
    if (result.objects) {
      for (const object of result.objects) {
        // 排除目录占位符自身
        if (object.key === normalizedPrefix || object.key === prefix) continue;

        const isExplicitDir =
          object.key.endsWith('/') ||
          object.customMetadata?.resourcetype === 'collection';

        if (isExplicitDir) {
          const cleanPath = object.key.endsWith('/') ? object.key.slice(0, -1) : object.key;
          const dirName = cleanPath.split('/').pop() || cleanPath;
          const dirKey = object.key.endsWith('/') ? object.key : `${object.key}/`;
          if (!seenDirectories.has(dirKey)) {
            seenDirectories.add(dirKey);
            items.push({
              key: dirKey,
              name: dirName,
              isDirectory: true,
            });
          }
        } else {
          const fileName = object.key.split('/').pop() || object.key;
          items.push({
            key: object.key,
            name: fileName,
            isDirectory: false,
            size: object.size,
            uploaded: object.uploaded,
            etag: object.etag,
            contentType: object.httpMetadata?.contentType,
          });
        }
      }
    }

    if (result.truncated) {
      truncated = true;
      cursor = result.cursor;
    } else {
      truncated = false;
      cursor = undefined;
    }
  }

  // 排序：文件夹排在前，文件排在后，均按名称字母序
  return items.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * 保持向后兼容性，供 PROPFIND 等内部调用
 */
export async function* listAll(bucket: R2Bucket, prefix: string) {
  const options: R2ListOptions = { prefix, delimiter: "/" };
  let result = await bucket.list(options);
  while (true) {
    for (const object of result.objects) {
      yield object;
    }
    if (result.truncated) {
      result = await bucket.list({ ...options, cursor: result.cursor });
    } else {
      break;
    }
  }
}

export function fromR2Object(object: R2Object | null): WebDAVProps {
  if (!object) {
    return {
      creationdate: new Date().toUTCString(),
      displayname: undefined,
      getcontentlanguage: undefined,
      getcontentlength: "0",
      getcontenttype: undefined,
      getetag: undefined,
      getlastmodified: new Date().toUTCString(),
      resourcetype: "collection"
    };
  }
  return {
    creationdate: object.uploaded.toUTCString(),
    displayname: object.key.split('/').pop(),
    getcontentlanguage: object.httpMetadata?.contentLanguage,
    getcontentlength: object.size.toString(),
    getcontenttype: object.httpMetadata?.contentType,
    getetag: object.etag,
    getlastmodified: object.uploaded.toUTCString(),
    resourcetype: object.customMetadata?.resourcetype || (object.key.endsWith('/') ? "collection" : "")
  };
}

export function generatePropfindResponse(bucketName: string, basePath: string, props: WebDAVProps[]): string {
  const responses = props.map(prop => generatePropResponse(bucketName, basePath, prop)).join("\n");
  return `<?xml version="1.0" encoding="utf-8" ?>
  <D:multistatus xmlns:D="DAV:">${responses}
  </D:multistatus>`;
}

function generatePropResponse(bucketName: string, basePath: string, prop: WebDAVProps): string {
  const resourcePath = `/${bucketName}/${basePath}${prop.displayname ? '/' + prop.displayname : ''}`;
  return `  <D:response>
    <D:href>${resourcePath}</D:href>
    <D:propstat>
      <D:prop>
        <D:creationdate>${prop.creationdate}</D:creationdate>
        <D:getcontentlength>${prop.getcontentlength}</D:getcontentlength>
        <D:getcontenttype>${prop.getcontenttype || ''}</D:getcontenttype>
        <D:getetag>${prop.getetag || ''}</D:getetag>
        <D:getlastmodified>${prop.getlastmodified}</D:getlastmodified>
        <D:resourcetype>${prop.resourcetype ? '<D:collection/>' : ''}</D:resourcetype>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
  </D:response>`;
}
