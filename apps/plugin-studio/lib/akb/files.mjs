import {sdk} from '../sdk.mjs';
const files = (await sdk()).protectedFiles;
export const {outside,protectedRead,newDirectory,newFile,readJSON,writeJSON} = files;
