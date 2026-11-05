import {constants} from 'node:fs';
import {open} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {ControlPaidCredits,validatePaidCreditReconciliation} from './control-paid-credits.mjs';
import {GatewayError,fail} from './policy.mjs';
import {Store} from './store.mjs';

const MAX_FILE_BYTES=4096;

export async function readPaidCreditReconciliationFile(path){
 let file;
 try{
  // Open the descriptor first to avoid checking one file and reading another.
  file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const stat=await file.stat();
  if(!stat.isFile()||stat.uid!==process.geteuid()||(stat.mode&0o077)!==0||stat.size>MAX_FILE_BYTES)
   fail('paid_credit_reconciliation_file_invalid',400);
  const buffer=Buffer.alloc(MAX_FILE_BYTES+1);
  let size=0;
  while(size<buffer.length){
   const {bytesRead}=await file.read(buffer,size,buffer.length-size,null);
   if(!bytesRead)break;
   size+=bytesRead;
  }
  if(size>MAX_FILE_BYTES)fail('paid_credit_reconciliation_file_invalid',400);
  const json=new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,size));
  return validatePaidCreditReconciliation(JSON.parse(json));
 }catch(error){
  if(error instanceof GatewayError)throw error;
  fail('paid_credit_reconciliation_file_invalid',400);
 }finally{
  await file?.close();
 }
}

async function main(args){
 let store;
 try{
  if(args.length!==1)fail('paid_credit_reconciliation_input_required',400);
  const input=await readPaidCreditReconciliationFile(args[0]);
  if(!process.env.DATABASE_URL)fail('paid_credit_reconciliation_database_required',503);
  store=new Store(process.env.DATABASE_URL);
  const paidCredits=new ControlPaidCredits({store,config:{}});
  const result=await store.tx(c=>paidCredits.reconcileHeld(c,input));
  process.stdout.write(JSON.stringify(result)+'\n');
 }catch(error){
  // Never echo filenames, input, evidence, database errors, or credentials.
  const code=error instanceof GatewayError?error.code:'paid_credit_reconciliation_failed';
  process.stderr.write(code+'\n');
  process.exitCode=1;
 }finally{
  await store?.close();
 }
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main(process.argv.slice(2));
