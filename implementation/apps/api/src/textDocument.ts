import {extname} from 'node:path';
export const DOCUMENT_LIMIT=2*1024*1024;
export function decodeDocument(bytes:Buffer){
  if(!bytes.length||bytes.length>DOCUMENT_LIMIT)throw Error('DOCUMENT_SIZE_EXCEEDED');
  let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('DOCUMENT_ENCODING_REJECTED');}
  if(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text))throw Error('DOCUMENT_ENCODING_REJECTED');
  let characterCount=0,lineCount=1;for(const point of text){characterCount++;if(point==='\n')lineCount++;}
  // Treat CRLF as one line break and lone CR as a line break; preserve bytes.
  for(let i=0;i<text.length;i++)if(text[i]==='\r'&&text[i+1]!=='\n')lineCount++;
  return {text,characterCount,lineCount,hasBom:bytes.length>=3&&bytes[0]===0xef&&bytes[1]===0xbb&&bytes[2]===0xbf};
}
export function documentMime(name:string,declared:string){
  if(!name||name.length>240||/[\\/\x00-\x1f]/.test(name))throw Error('INVALID_ASSET_NAME');
  const mime=({'.txt':'text/plain','.md':'text/markdown','.csv':'text/csv'} as Record<string,string>)[extname(name).toLowerCase()];
  if(!mime)throw Error('DOCUMENT_TYPE_REJECTED');const sent=declared.split(';')[0].trim().toLowerCase();
  if(!['','application/octet-stream',mime,...(mime==='text/markdown'?['text/plain']:[]),...(mime==='text/csv'?['application/vnd.ms-excel']:[])].includes(sent))throw Error('DOCUMENT_TYPE_REJECTED');return mime;
}
