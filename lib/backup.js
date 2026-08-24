const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');

const HF_TOKEN = process.env.HF_TOKEN || '';
const HF_USER = process.env.HF_USER || '';
const HF_DB_REPO = process.env.HF_DB_REPO || '';
const BACKUP_SECRET = process.env.BACKUP_SECRET || '';
const BACKUP_INTERVAL_MS = 5 * 60 * 1000;

let cloneDir = null;
let dirtySincePush = false;
let storeRef = null;

function enabled() {
  return !!(HF_TOKEN && HF_USER && HF_DB_REPO && BACKUP_SECRET);
}

function encKey() {
  return crypto.scryptSync(BACKUP_SECRET, 'nexochat-backup-v1', 32);
}

function encryptBuffer(data) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), iv);
  const ct = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]);
}

function decryptBuffer(blob) {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ct = blob.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]);
}

function gitRemote() {
  if (process.env.HF_GIT_BASE) {
    return `${process.env.HF_GIT_BASE.replace(/\/$/, '')}/${HF_DB_REPO}`;
  }
  return `https://${HF_USER}:${HF_TOKEN}@huggingface.co/datasets/${HF_DB_REPO}`;
}

function restore() {
  if (!enabled()) return false;
  try {
    execSync('git lfs version', { stdio: 'ignore' });
  } catch {
    console.log('[backup] git-lfs ausente, backup desativado');
    return false;
  }
  const tmp = path.join(os.tmpdir(), `nexodb-${Date.now()}`);
  try {
    execSync(`git clone --depth 1 ${gitRemote()} ${tmp}`, { stdio: 'pipe' });
    cloneDir = tmp;
    const dbEnc = path.join(tmp, 'db.enc');
    if (fs.existsSync(dbEnc)) {
      let restored;
      try {
        restored = decryptBuffer(fs.readFileSync(dbEnc));
        JSON.parse(restored.toString('utf8'));
      } catch (e) {
        console.log('[backup] ERRO GRAVE: db.enc existe mas nao decripta. Segredo errado ou arquivo corrompido.');
        return false;
      }
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFileSync(DB_FILE, restored);
      console.log(`[backup] banco restaurado do dataset (${restored.length} bytes)`);
      const filesEnc = path.join(tmp, 'files.enc');
      if (fs.existsSync(filesEnc)) {
        let tmpTar = null;
        try {
          tmpTar = path.join(os.tmpdir(), `nexofiles-${Date.now()}.tar.gz`);
          fs.writeFileSync(tmpTar, decryptBuffer(fs.readFileSync(filesEnc)));
          execSync(`tar -xzf "${tmpTar}" -C "${DATA_DIR}"`, { stdio: 'pipe' });
          console.log('[backup] anexos restaurados');
        } catch (e) {
          console.log('[backup] anexos nao restaurados:', String(e.message).split('\n')[0]);
        } finally {
          if (tmpTar) { try { fs.unlinkSync(tmpTar); } catch {} }
        }
      }
      return true;
    }
    console.log('[backup] dataset vazio, comecando banco novo');
    return false;
  } catch (e) {
    console.log('[backup] sem backup para restaurar:', e.message.split('\n')[0]);
    try { execSync(`rm -rf ${tmp}`, { stdio: 'ignore' }); } catch {}
    return false;
  }
}

function currentBranch(cwd) {
  try {
    const b = execSync('git symbolic-ref --short HEAD', { cwd, encoding: 'utf8' }).trim();
    if (b && b !== 'HEAD') return b;
  } catch {}
  try {
    const out = execSync('git ls-remote --symref origin HEAD', { cwd, encoding: 'utf8' });
    const m = out.match(/refs\/heads\/(\S+)/);
    if (m) return m[1];
  } catch {}
  return 'main';
}

function pushNow(reason) {
  if (!enabled() || !cloneDir) return;
  try {
    try { storeRef.flushSync(); } catch {}
    fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    const dbBlob = encryptBuffer(fs.readFileSync(DB_FILE));
    fs.writeFileSync(path.join(cloneDir, 'db.enc'), dbBlob);

    let filesBlob = null;
    const hasFiles = fs.existsSync(ATTACHMENTS_DIR) && fs.readdirSync(ATTACHMENTS_DIR).length > 0;
    if (hasFiles) {
      const tarBuf = execSync(`tar -czf - -C "${DATA_DIR}" attachments`, { maxBuffer: 200 * 1024 * 1024 });
      filesBlob = encryptBuffer(tarBuf);
      fs.writeFileSync(path.join(cloneDir, 'files.enc'), filesBlob);
    }

    const totalMb = (dbBlob.length + (filesBlob ? filesBlob.length : 0)) / 1024 / 1024;
    if (totalMb > 900) {
      console.log(`[backup] snapshot muito grande (${totalMb.toFixed(1)} MB), pulando`);
      return;
    }

    const branch = currentBranch(cloneDir);
    const attrs = process.env.HF_LFS === '1'
      ? '*.enc -text\n*.enc filter=lfs diff=lfs merge=lfs -text\n'
      : '*.enc -text\n';
    fs.writeFileSync(path.join(cloneDir, '.gitattributes'), attrs);
    const gitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'nexobot', GIT_AUTHOR_EMAIL: 'bot@local',
      GIT_COMMITTER_NAME: 'nexobot', GIT_COMMITTER_EMAIL: 'bot@local'
    };
    execSync('git add -A && (git commit --amend -m "backup" || git commit -m "backup") && git push -f origin ' + branch, {
      cwd: cloneDir,
      stdio: 'pipe',
      env: gitEnv
    });
    dirtySincePush = false;
    console.log(`[backup] enviado ao dataset (${reason}, ${totalMb.toFixed(2)} MB)`);
  } catch (e) {
    const msg = String(e.stderr || e.message).split('\n').filter(Boolean).slice(0, 4).join(' | ');
    console.log('[backup] falha no envio:', msg);
  }
}

function markDirty() {
  dirtySincePush = true;
}

function init(store) {
  storeRef = store;
  if (!enabled()) {
    console.log('[backup] desativado (defina HF_TOKEN, HF_USER, HF_DB_REPO, BACKUP_SECRET)');
    return;
  }
  restore();
  setInterval(() => {
    if (dirtySincePush) pushNow('periodico');
  }, BACKUP_INTERVAL_MS);
  process.on('SIGTERM', () => {
    console.log('\n[backup] SIGTERM: salvando antes de sair...');
    pushNow('desligamento');
    process.exit(0);
  });
  process.on('SIGINT', () => {
    pushNow('ctrl-c');
    process.exit(0);
  });
}

module.exports = { init, markDirty, pushNow, encryptBuffer, decryptBuffer, enabled };
