import {createRequire} from 'node:module';
import {realpathSync,writeFileSync} from 'node:fs';
import {resolve,relative,isAbsolute,dirname} from 'node:path';
import {contentHash} from '../apps/api/src/workspacePrototype.ts';
import {LocalWorkspaceDatabase} from '../apps/api/src/localWorkspaceDatabase.ts';

// Operator-only restore drill. Never opens the live database or the retained
// original backup, and never prints rows, credentials, sessions or asset names.
const root=process.cwd(),backupRoot=realpathSync(resolve('work/local-workspace/backups'));
const directory=realpathSync(resolve(process.argv[2]??'')),rel=relative(backupRoot,directory);
if(rel.startsWith('..')||isAbsolute(rel)||!/(?:^|[\\/])restore-check-[0-9a-f-]{36}[\\/]postgres$/.test(rel))throw Error('OWNED_RESTORE_COPY_REQUIRED');
const {PGlite}=createRequire(new URL('../apps/api/package.json',import.meta.url))('@electric-sql/pglite');
async function inspect(tables?:{schemaname:string;tablename:string}[]){
  const db=await PGlite.create(directory);
  try{
    tables??=(await db.query("SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('workspace','workspace_auth') ORDER BY schemaname,tablename")).rows;
    const summary:Record<string,{count:number;digest:string}>={};
    for(const table of tables!){
      if(!/^[a-z_]+$/.test(table.schemaname)||!/^[a-z_]+$/.test(table.tablename))throw Error('INVALID_TABLE_NAME');
      const rows=(await db.query(`SELECT to_jsonb(t)-'binding_order'-'event_sequence' AS item FROM "${table.schemaname}"."${table.tablename}" t`)).rows;
      summary[table.schemaname+'.'+table.tablename]={count:rows.length,digest:contentHash(rows.map((row:{item:unknown})=>contentHash(row.item)).sort())};
    }
    const versions=(await db.query('SELECT version FROM public.workspace_migrations ORDER BY version')).rows.map((row:{version:number})=>row.version);
    return {tables:tables!,summary,versions};
  }finally{await db.close();}
}
const before=await inspect();
const migrated=await LocalWorkspaceDatabase.open(root,directory);await migrated.close();
const after=await inspect(before.tables);
if(contentHash(before.summary)!==contentHash(after.summary))throw Error('UPGRADE_CHANGED_EXISTING_DATA');
const report={scope:'private-backup-copy-migration-drill',passed:true,originalBackupUntouched:true,beforeVersions:before.versions,afterVersions:after.versions,existingTables:before.summary};
writeFileSync(resolve(dirname(directory),'verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({passed:true,beforeVersions:before.versions,afterVersions:after.versions,tableCount:before.tables.length}));
