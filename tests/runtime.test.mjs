import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MongoMemoryReplSet} from 'mongodb-memory-server';
import {MongoClient} from 'mongodb';

test('automatic local development database preserves records across restart',async()=>{
 const dbPath=await fs.mkdtemp(path.join(os.tmpdir(),'jos-persist-'));
 let mongo,client;
 try {
  mongo=await MongoMemoryReplSet.create({replSet:{count:1,name:'jos-persist',args:['--nounixsocket']},instanceOpts:[{dbPath}]});
  const port=mongo.servers[0].instanceInfo.port;
  client=new MongoClient(mongo.getUri('persistent_test'));await client.connect();
  await client.db().collection('test').insertOne({_id:'saved',value:42});await client.close();
  await mongo.stop({doCleanup:false});
  mongo=await MongoMemoryReplSet.create({replSet:{count:1,name:'jos-persist',args:['--nounixsocket']},instanceOpts:[{dbPath,port}]});
  client=new MongoClient(mongo.getUri('persistent_test'));await client.connect();
  assert.equal((await client.db().collection('test').findOne({_id:'saved'})).value,42);
 } finally {await client?.close();await mongo?.stop({doCleanup:false});await fs.rm(dbPath,{recursive:true,force:true});}
});
