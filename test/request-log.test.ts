import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { promptPreview } from '../src/request-log.ts';
import type { RequestDetails } from '../src/types.ts';

test('previews select only the latest visible user text and redact common credentials', () => {
 const preview = promptPreview({input:[
  {role:'system',content:'private system instructions'},
  {role:'user',content:'older private message'},
  {role:'assistant',content:'private assistant output'},
  {type:'reasoning',encrypted_content:'encrypted private state'},
  {role:'user',content:[{type:'input_text',text:'Help with a cover letter. Bearer secret-jwt-token vcp_secret_access_key123 password="hidden value" sk-secretapikey123'}, {type:'input_image',image_url:'data:image/png;base64,private-image'}]},
  {type:'function_call_output',output:'private tool result'},
 ]});
 assert.match(preview,/Help with a cover letter/);
 for(const secret of ['secret-jwt-token','secret_access_key123','hidden value','secretapikey123','private-image','older private','private system','private assistant','private tool','encrypted private'])assert.equal(preview.includes(secret),false);
 assert.match(preview,/\[redacted\]/);
 assert.equal(promptPreview({input:'x'.repeat(5000)}).length,600);
 assert.equal(promptPreview({messages:[{role:'user',content:[{type:'text',text:'Claude message'},{type:'image',source:{data:'private-image'}}]}]}),'Claude message');
 assert.equal(promptPreview({input:[{role:'user',content:[{type:'input_image',image_url:'private'}]}]}),'');
});

test('existing databases migrate without losing historical requests', t => {
 const directory=mkdtempSync(join(tmpdir(),'vibe-log-test-'));
 t.after(()=>rmSync(directory,{recursive:true,force:true}));
 const path=join(directory,'old.db');
 const old=new DatabaseSync(path);
 old.exec(`CREATE TABLE events(id TEXT PRIMARY KEY,at INTEGER NOT NULL,member_id TEXT NOT NULL,member_name TEXT NOT NULL,model TEXT NOT NULL,account_id TEXT,status INTEGER NOT NULL,duration INTEGER NOT NULL,reason TEXT);
 INSERT INTO events VALUES('old',1,'member','Friend','model','account',200,123,NULL)`);
 old.close();
 const store=new Store(path);t.after(()=>store.close());
 assert.equal(store.settings().queueWaitSeconds,180);
 store.setSettings({...store.settings(),queueWaitSeconds:240,maxOutputTokens:16384});
 const reopened=new Store(path);
 assert.equal(reopened.settings().queueWaitSeconds,240);assert.equal(reopened.settings().maxOutputTokens,16384);reopened.close();
 const row=store.history()[0];assert.equal(row.id,'old');assert.equal(row.status,200);assert.equal(row.details,null);
 const member=store.create({name:'Test',sharePercent:20,paused:false,allowedModels:[],accountIds:[],expiresAt:null,rpm:20,fallbackOnly:true}).member;
 const details:RequestDetails={method:'POST',path:'/v1/responses',state:'receiving',startedAt:Date.now(),requestBytes:0,responseBytes:0,queueMs:0,promptPreview:'private short preview'};
 store.event(member,'model',null,102,0,null,details,'pending');
 store.progress('pending','model','account',{...details,state:'running'});
 store.interruptPending();
 const pending=store.history().find(row=>row.id==='pending');assert.equal(pending.status,503);assert.equal(pending.reason,'hub_restarting');assert.equal(pending.details.state,'finished');
 store.event(member,'model',null,200,100,null,{...details,state:'finished'},'old-preview');
 store.db.prepare('UPDATE events SET at=? WHERE id=?').run(Date.now()-8*86400000,'old-preview');
 store.prune();
 const retained=store.history().find(row=>row.id==='old-preview');assert.equal(retained.details.promptPreview,undefined);assert.equal(retained.details.path,'/v1/responses');
});
