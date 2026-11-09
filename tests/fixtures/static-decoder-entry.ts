import {decodeStaticImage,MAX_STATIC_IMAGE_PIXELS} from '../../apps/api/src/staticImageDecoder.ts';
import {RunKernelError} from '../../apps/api/src/runKernel.ts';
try{await decodeStaticImage(Buffer.from('not-an-image'),'image/png');throw Error('unexpected acceptance');}
catch(error){if(!(error instanceof RunKernelError)||error.code!=='verified_asset_mime_mismatch'||MAX_STATIC_IMAGE_PIXELS!==16_000_000)throw error;}
console.log('standalone-decoder-entry-ok');
