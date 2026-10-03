import fs from 'node:fs';
import vm from 'node:vm';

// ---- Regression guard: a delete that failed must not look like it worked -----
// deleteChat removes a project's hosted sites, its serverless workers, its app
// directory, the published copy and the saved conversation. Every one of those
// failures used to be swallowed with a console warning, and the project was
// then dropped from the sidebar and tombstoned regardless. A transient service
// error therefore left a public site and an account-level worker running with
// no UI path back to them: the entry that carried their URLs was gone.
//
// A failure that is "already not there" is a successful deletion; anything else
// must leave the project listed, untombstoned and retryable, and say so.
//
// That "anything else" is a transaction over TWO phases. Phase 1 removes the
// live surface (sites, workers, project files). Phase 2 — which only runs once
// phase 1 is clean — destroys the private history the sidebar entry was the
// last handle on: version snapshots, the issues list, the conversation file.
// The checks below pin both the ordering and the reason: an unfinished delete
// must never be the thing that takes a project's restore points with it.
//
// Drives the real deleteChat (VM sandbox, only the FS/hosting/worker/UI
// boundary mocked) with each cleanup step failing in turn.

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log('ok   - ' + name);
    else { console.error('FAIL - ' + name + (detail ? '\n       ' + detail : '')); failures++; }
}

const appSource = fs.readFileSync(new URL('../src/js/app.js', import.meta.url), 'utf8');
const ownershipSource = fs.readFileSync(new URL('../src/js/worker-ownership.js', import.meta.url), 'utf8');

function extract(src, signature) {
    const a = src.indexOf(signature);
    if (a < 0) throw new Error('could not find ' + signature);
    const b = src.indexOf('\n}\n', a);
    if (b < 0) throw new Error('could not find the end of ' + signature);
    return src.slice(a, b + 2);
}
const CODE = [
    'const _deletedChatIds = new Set();',
    extract(appSource, 'function isNotFoundError(error) {'),
    extract(appSource, 'async function deleteChat(chatId) {'),
].join('\n\n');

const APP_DIR = '/alice/AppData/builder/chat1';

function notFound() { const e = new Error('not found'); e.code = 'subject_does_not_exist'; return e; }

// Private history is stored per chat, so a delete drops every key of THAT chat
// and nothing else — a neighbouring project's restore points must survive.
function dropChatKeys(set, chatId) {
    for (const k of [...set]) if (k.startsWith(chatId + ':')) set.delete(k);
}

// failing: which step rejects, and with what kind of error.
async function run({ failing = null, notFoundOnly = false } = {}) {
    const sites = new Set(['draft-one', 'pub-one']);
    const workers = new Map([['api-a', { name: 'api-a', file_path: APP_DIR + '/workers/api-a.js' }]]);
    const dirs = new Set([APP_DIR, '/alice/AppData/builder/.published/chat1', 'chat-history/chat1.json']);
    const alerts = [];
    // The project's private history: restore points and the issues list. Kept
    // out of `dirs` because they are deleted through their own window hooks,
    // not through puter.fs.delete.
    const history = {
        snapshots: new Set(['chat1:v1', 'chat1:v2', 'chat2:v1']),
        issues: new Set(['chat1:i1', 'chat2:i1']),
    };
    const boom = step => {
        if (failing !== step) return null;
        return notFoundOnly ? notFound() : new Error('service unavailable');
    };

    const sandbox = {
        savedChats: [
            { id: 'chat1', title: 'Notes', previewUrl: 'https://draft-one.puter.site/', publishedUrl: 'https://pub-one.puter.site/' },
            { id: 'chat2', title: 'Other' },
        ],
        currentChatId: 'chat2',
        terminateActiveTurn() {},
        new_chat() {},
        saveChatList: async () => {},
        updateChatHistorySidebar() {},
        clearComposerDraft() {},
        _chatSavePending: new Map(),
        _suggestionsByChat: new Map(),
        console: { warn() {}, error() {} },
        window: {
            user: { username: 'alice' },
            animateChatItemRemoval: async () => {},
            // Real calls, recorded: whether these run at all is the point.
            deleteChatVersions: async (id) => {
                if (boom('versions')) throw boom('versions');
                dropChatKeys(history.snapshots, id);
            },
            deleteChatIssues: async (id) => {
                if (boom('issues')) throw boom('issues');
                dropChatKeys(history.issues, id);
            },
        },
        puter: {
            appID: 'builder',
            ui: { alert: async m => alerts.push(String(m)) },
            hosting: {
                delete: async sub => {
                    const e = boom('hosting'); if (e) throw e;
                    if (!sites.has(sub)) throw notFound();
                    sites.delete(sub);
                },
            },
            workers: {
                list: async () => {
                    const e = boom('worker-list'); if (e) throw e;
                    return [...workers.values()];
                },
                delete: async name => {
                    const e = boom('worker-delete'); if (e) throw e;
                    if (!workers.has(name)) throw notFound();
                    workers.delete(name);
                },
            },
            fs: {
                delete: async path => {
                    if (path === APP_DIR) { const e = boom('appdir'); if (e) throw e; }
                    if (path.startsWith('chat-history/')) { const e = boom('chatfile'); if (e) throw e; }
                    if (!dirs.has(path)) throw notFound();
                    dirs.delete(path);
                },
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(ownershipSource, sandbox, { filename: 'src/js/worker-ownership.js' });
    vm.runInContext(CODE, sandbox, { filename: 'src/js/app.js' });

    let threw = false;
    let error = null;
    try { await sandbox.deleteChat('chat1'); } catch (e) { threw = true; error = e; }

    return {
        threw,
        // Callers branch on partialDelete to tell "stopped, still there" from a
        // hard failure, so the flag is part of the contract.
        partialDelete: !!error?.partialDelete,
        error: error && String(error.message || ''),
        alerts,
        restorePointsLeft: [...history.snapshots].sort(),
        issuesLeft: [...history.issues].sort(),
        conversationLeft: dirs.has('chat-history/chat1.json'),
        stillListed: sandbox.savedChats.some(c => c.id === 'chat1'),
        tombstoned: sandbox.deleteChat && vm.runInContext("_deletedChatIds.has('chat1')", sandbox),
        sitesLeft: [...sites].sort(),
        workersLeft: [...workers.keys()],
        dirsLeft: [...dirs].sort(),
    };
}

// ---- Control: everything goes -----------------------------------------------
const ok = await run();
check('control: the project leaves the sidebar', ok.stillListed === false);
check('control: sites and workers are gone',
    ok.sitesLeft.length === 0 && ok.workersLeft.length === 0,
    JSON.stringify({ sites: ok.sitesLeft, workers: ok.workersLeft }));
check('control: files are gone', ok.dirsLeft.length === 0, JSON.stringify(ok.dirsLeft));
check('control: tombstoned so a late save cannot resurrect it', ok.tombstoned === true);
check('control: no error shown', ok.alerts.length === 0 && ok.threw === false, JSON.stringify(ok.alerts));
check('control: not reported as a partial delete', ok.partialDelete === false);

// ---- Each cleanup step failing in turn --------------------------------------
for (const [step, label, survives, named] of [
    ['hosting', 'a hosted site', r => r.sitesLeft.length > 0, /the site \S+\.puter\.site/],
    ['worker-list', 'the worker enumeration', r => r.workersLeft.length > 0, /workers/],
    ['worker-delete', 'a worker', r => r.workersLeft.length > 0, /the worker api-a/],
    ['appdir', 'the project files', r => r.dirsLeft.includes(APP_DIR), /the project files/],
    ['chatfile', 'the saved conversation', r => r.dirsLeft.some(d => d.startsWith('chat-history/')), /the saved conversation/],
]) {
    const r = await run({ failing: step });
    check(`${step}: the resource really did survive (${label})`, survives(r), JSON.stringify(r));
    check(`${step}: the project stays in the sidebar`, r.stillListed === true, JSON.stringify(r));
    check(`${step}: the project is not tombstoned, so it can be deleted again`, r.tombstoned === false);
    check(`${step}: the user is told what could not be removed`,
        r.alerts.length === 1 && /could not be removed|couldn.t/i.test(r.alerts[0]), JSON.stringify(r.alerts));
    // The whole point of the retry message: it names the resource that is still
    // there, so "which one?" never has to be guessed at.
    check(`${step}: the alert names what could not be removed`, named.test(r.alerts[0] || ''), JSON.stringify(r.alerts));
    check(`${step}: the caller sees the failure, flagged as partial`, r.threw === true && r.partialDelete === true,
        JSON.stringify({ threw: r.threw, partialDelete: r.partialDelete }));
    // The thrown error is what the caller's log/analytics get, so it has to
    // carry the same list the alert does.
    check(`${step}: the thrown error names what could not be removed`, named.test(r.error || ''),
        JSON.stringify(r.error));
}

// ---- The delete is a transaction: phase 2 only runs once phase 1 is clean ---
// Every one of these leaves the project listed and re-deletable, so destroying
// its restore points / issues / conversation in the same pass is pure loss: the
// user is told to "try again" with nothing left to try again WITH.
for (const step of ['hosting', 'worker-list', 'worker-delete', 'appdir']) {
    const r = await run({ failing: step });
    check(`${step}: the project's restore points survive an unfinished delete`,
        JSON.stringify(r.restorePointsLeft) === JSON.stringify(['chat1:v1', 'chat1:v2', 'chat2:v1']) &&
        JSON.stringify(r.issuesLeft) === JSON.stringify(['chat1:i1', 'chat2:i1']), JSON.stringify(r));
    check(`${step}: the saved conversation survives an unfinished delete`,
        r.conversationLeft === true, JSON.stringify({ conversationLeft: r.conversationLeft }));
    check(`${step}: the project can still be opened from its entry`,
        r.conversationLeft === true && r.stillListed === true, JSON.stringify(r));
}

// The phase-2 steps themselves are best-effort: a failed snapshot or issue
// delete costs storage, never a live endpoint, so it must NOT keep the entry.
for (const step of ['versions', 'issues']) {
    const r = await run({ failing: step });
    check(`${step}: a failed private-history delete still completes the delete`,
        r.stillListed === false && r.threw === false && r.alerts.length === 0, JSON.stringify(r));
    check(`${step}: the failed delete leaves only its own leftovers, never the neighbour's`,
        r.restorePointsLeft.includes('chat2:v1') && r.issuesLeft.includes('chat2:i1'), JSON.stringify(r));
    check(`${step}: the rest of the history is still cleaned up`,
        r.conversationLeft === false && r.dirsLeft.length === 0, JSON.stringify(r));
}

// Control, restated over the private history: a clean delete takes all of it.
check('control: restore points and issues go with the project, and only with it',
    JSON.stringify(ok.restorePointsLeft) === JSON.stringify(['chat2:v1']) &&
    JSON.stringify(ok.issuesLeft) === JSON.stringify(['chat2:i1']) && ok.conversationLeft === false,
    JSON.stringify(ok));

// A retry after a partial delete finishes the job — including phase 2.
{
    let r = await run({ failing: 'hosting' });
    check('retry: the first pass keeps everything and reports the failure',
        r.threw === true && r.stillListed === true &&
        r.restorePointsLeft.length === 3 && r.conversationLeft === true, JSON.stringify(r));
    r = await run();
    check('retry: a later clean pass removes the project and its whole history',
        r.stillListed === false && JSON.stringify(r.restorePointsLeft) === JSON.stringify(['chat2:v1']) &&
        JSON.stringify(r.issuesLeft) === JSON.stringify(['chat2:i1']) &&
        r.conversationLeft === false && r.dirsLeft.length === 0,
        JSON.stringify(r));
}

// ---- "Already gone" is a successful deletion, not a failure -----------------
for (const step of ['hosting', 'worker-delete', 'appdir', 'chatfile', 'versions', 'issues']) {
    const r = await run({ failing: step, notFoundOnly: true });
    check(`${step}/not-found: the delete completes normally`,
        r.stillListed === false && r.alerts.length === 0 && r.threw === false,
        JSON.stringify(r));
}

if (failures) { console.error(failures + ' failure(s)'); process.exit(1); }
console.log('all delete-cleanup checks passed');
