/*
 * Sobe a foto da IA (saida/<código>_card-ia.jpg) no Jetimob como NOVA 1ª foto (capa) do imóvel.
 * A capa antiga continua lá, em 2º — nada é apagado. A API do Jetimob é só leitura, então isto
 * usa o painel (app.jetimob.com) pelo navegador, como uma pessoa faria:
 *   abre /imoveis/<código>/editar -> "Adicionar imagem" -> arrasta a nova para o 1º lugar -> Salvar.
 *
 * Antes de deixar o Salvar sair, confere o JSON enviado: tem que ter exatamente as fotos de antes,
 * na mesma ordem, com a nova na frente. Se não bater, cancela o envio e não grava nada.
 *
 * USO:
 *   node publicar.js --teste 16504        -> ensaio: faz tudo mas BLOQUEIA o envio ao Jetimob (nada muda)
 *   node publicar.js 16504 111333         -> publica esses códigos
 *   node publicar.js --todos              -> publica todas as fotos prontas (status ok em saida/estado.json)
 *                                            que ainda não foram publicadas e não estão em rejeitados.txt
 *   node publicar.js --so-site 16504      -> só manda o site puxar o imóvel do Jetimob agora
 *   --max=N    no máximo N nesta rodada        --pausa=S  segundos entre imóveis (padrão 5)
 *   --ver      mostra a janela do Chrome
 *
 * Depois de gravar no Jetimob, dispara "Atualizar Imóvel por Código" no admin do site
 * (casamarimoveis.net/admin/imovel/) para a foto aparecer na hora, sem esperar a importação da madrugada.
 *
 * Login: JET_EMAIL/JET_SENHA (Jetimob) e SITE_LOGIN/SITE_SENHA (admin do site) no arquivo .env.
 * A sessão do Jetimob fica salva em perfil-jetimob/.
 * Registro: saida/publicados.json (o melhorar.js não refaz imóvel já publicado).
 * rejeitados.txt: códigos que você conferiu no *_comparar.jpg e NÃO quer publicar (um por linha).
 */

const fs = require('fs');
const path = require('path');
const { chromium, request } = require('playwright');
const { DADOS, SAIDA, guardarPrint, argsChrome } = require('./fotos');

// ---------- argumentos e config ----------
const args = process.argv.slice(2);
const flag = (nome) => args.some(a => a === `--${nome}`);
const valor = (nome) => (args.find(a => a.startsWith(`--${nome}=`)) || '').split('=').slice(1).join('=') || null;
const TESTE = flag('teste');
const TODOS = flag('todos');
const VER = flag('ver');
const SO_SITE = flag('so-site');
// --ate=<data ISO>: depois disso não pega imóvel novo (janela da madrugada do agendador.js)
const PRAZO = valor('ate') ? Date.parse(valor('ate')) : null;
const MAX = +(valor('max') || 0);
const PAUSA = +(valor('pausa') || 5);
const CODIGOS = args.filter(a => !a.startsWith('--'));

function lerEnv() {
  const arq = path.join(__dirname, '.env');
  if (!fs.existsSync(arq)) return;
  for (const linha of fs.readFileSync(arq, 'utf8').split(/\r?\n/)) {
    const m = linha.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
lerEnv();

const PAINEL = 'https://app.jetimob.com';
const PERFIL = process.env.JETIMOB_PERFIL || path.join(__dirname, 'perfil-jetimob');
const ARQ_ESTADO = path.join(SAIDA, 'estado.json');
const ARQ_PUBLICADOS = path.join(SAIDA, 'publicados.json');
const ARQ_REJEITADOS = path.join(DADOS, 'rejeitados.txt');

const espera = (ms) => new Promise(r => setTimeout(r, ms));
const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };
const lerLista = (arq) => fs.existsSync(arq)
  ? fs.readFileSync(arq, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
  : [];

// ---------- painel ----------
async function abrirEdicao(page, codigo) {
  const url = `${PAINEL}/imoveis/${codigo}/editar`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  // O Jetimob aceita uma sessão por conta: se a conta foi usada em outro lugar, aparece
  // "Seu login foi revogado..." com o botão Continuar (retoma a sessão aqui).
  const revogado = page.getByText(/login foi revogado/i).first();
  if (await revogado.isVisible().catch(() => false)) {
    console.log('   o Jetimob tinha derrubado esta sessão (a conta foi usada em outro lugar); retomando...');
    await page.getByRole('button', { name: /continuar/i }).first().click({ timeout: 10000 }).catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
  }
  if (/login/i.test(await page.title()) || await page.locator('input[type=password]').count()) {
    if (!process.env.JET_EMAIL || !process.env.JET_SENHA) throw new Error('Sessão do Jetimob expirou e faltam JET_EMAIL/JET_SENHA no .env');
    console.log('   entrando no Jetimob...');
    await page.fill('input[type=email][placeholder="exemplo@email.com"]', process.env.JET_EMAIL);
    await page.fill('input[type=password]', process.env.JET_SENHA);
    await page.click('button[type=submit]:has-text("Entrar")');
    await page.waitForURL(u => !/\/$|login/.test(u.pathname), { timeout: 30000 }).catch(() => {});
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    if (await page.locator('input[type=password]').count()) throw new Error('Login no Jetimob falhou (confira JET_EMAIL/JET_SENHA)');
  }
  if (!page.url().includes(`/imoveis/${codigo}/editar`)) throw new Error(`Imóvel ${codigo} não abriu no painel (${page.url()})`);
  await page.locator('.images-grid').first().waitFor({ timeout: 30000 });
  // as fotos chegam depois da grade: espera aparecerem (imóvel no site sempre tem ao menos a capa)
  const fotos = page.locator('.images-grid').first().locator('.img-preview');
  for (let i = 0; i < 40 && await fotos.count() === 0; i++) await espera(500);
  if (await fotos.count() === 0) throw new Error('a grade de fotos do imóvel não carregou no Jetimob');
}

// As caixas da grade têm como id a URL da foto (ou blob: enquanto a nova não subiu).
const idsDaGrade = (page) => page.locator('.images-grid').first().locator('.img-preview').evaluateAll(es => es.map(e => e.id));

// urlAnterior: foto de IA que este script subiu antes (publicar de novo). Ela sai do JSON do Salvar,
// para a nova ficar no lugar dela em vez de acumular.
async function publicarUm(page, codigo, arquivo, urlAnterior = null) {
  await abrirEdicao(page, codigo);
  const grade = page.locator('.images-grid').first();
  await grade.scrollIntoViewIfNeeded();
  const antes = await idsDaGrade(page);

  // 1. envia a foto (o painel sobe na hora, em /api/upload-image)
  const upload = TESTE ? null : page.waitForResponse(r => r.url().includes('/api/upload-image') && r.request().method() === 'POST', { timeout: 120000 });
  await page.locator('input[type=file][accept="image/jpeg"]').first().setInputFiles(arquivo);
  if (upload) {
    const r = await upload;
    if (!r.ok()) throw new Error(`upload recusado pelo Jetimob: HTTP ${r.status()}`);
  }
  const caixas = grade.locator('.img-preview-box');
  for (let i = 0; i < 30 && await caixas.count() !== antes.length + 1; i++) await espera(500);
  const n = await caixas.count();
  if (n !== antes.length + 1) throw new Error(`esperava ${antes.length + 1} fotos na grade, tem ${n}`);
  await espera(1500);

  // 2. Salvar. A ordem das fotos é a ordem da lista "images" do JSON: em vez de arrastar na tela
  // (falha com muitas fotos, a grade passa do tamanho da janela), a nova vai para o 1º lugar na lista.
  // Confere antes: as de antes, na mesma ordem, mais uma nova. Tira a foto de IA anterior, se houver.
  const trocar = urlAnterior && antes.includes(urlAnterior) ? urlAnterior : null;
  const ficam = antes.filter(u => u !== trocar);
  let conferido = null;
  await page.route('**/api/imoveis/*/editar', async (route) => {
    const corpo = JSON.parse(route.request().postData() || '{}');
    const imagens = corpo.images || [];
    const novas = imagens.filter(i => !antes.includes(i.url));
    const velhas = imagens.filter(i => antes.includes(i.url));
    const ok = imagens.length === antes.length + 1 && novas.length === 1 && velhas.map(i => i.url).join('|') === antes.join('|');
    conferido = { ok, total: imagens.length, trocou: !!trocar };
    if (TESTE || !ok) return route.abort();
    corpo.images = [novas[0], ...velhas.filter(i => i.url !== trocar)];
    return route.continue({ postData: JSON.stringify(corpo) });
  });
  const resposta = TESTE ? null : page.waitForResponse(r => /\/api\/imoveis\/[^/]+\/editar/.test(r.url()) && r.request().method() === 'POST', { timeout: 60000 });
  await page.locator('a.jet-button.next.primary:has-text("Salvar")').first().click();
  if (resposta) {
    const r = await resposta.catch(() => null);
    if (!conferido) throw new Error(`o Salvar não enviou nada ao Jetimob (a tela tinha ${antes.length} fotos)`);
    if (!conferido.ok) throw new Error(`JSON do Salvar não bateu (${conferido.total} fotos, esperava ${antes.length + 1}); envio cancelado`);
    if (!r || !r.ok()) throw new Error(`Jetimob recusou o Salvar: HTTP ${r ? r.status() : 'sem resposta'}`);
  } else {
    for (let i = 0; i < 20 && !conferido; i++) await espera(500);
  }
  await page.unroute('**/api/imoveis/*/editar');
  if (TESTE) return { antes: ficam.length, conferido, trocou: !!trocar };

  // guarda a URL que a foto nova ganhou no Jetimob (para trocar ela se publicar de novo)
  await abrirEdicao(page, codigo);
  const gravadas = await idsDaGrade(page);
  if (gravadas.length !== ficam.length + 1 || ficam.includes(gravadas[0])) throw new Error('salvou, mas a grade recarregada não ficou como esperado; confira no painel');
  return { antes: ficam.length, conferido, trocou: !!trocar, urlNova: gravadas[0] };
}

// ---------- site ----------
// O site importa do Jetimob só de madrugada. Esta é a tela "Atualizar Imóvel por Código" do admin
// do site, que puxa o imóvel do Jetimob na hora. Formulários com CSRF (CodeIgniter).
const SITE = 'https://www.casamarimoveis.net';
let siteApi = null;

const csrfDe = (html) => (html.match(/name="csrf_test_name" value="([^"]+)"/) || [])[1];

async function entrarNoSite() {
  if (!process.env.SITE_LOGIN || !process.env.SITE_SENHA) throw new Error('faltam SITE_LOGIN/SITE_SENHA no .env');
  const api = await request.newContext({ userAgent: 'Mozilla/5.0' });
  const csrf = csrfDe(await (await api.get(`${SITE}/admin/login/`)).text());
  await api.post(`${SITE}/admin/entrar/`, { form: { csrf_test_name: csrf, login: process.env.SITE_LOGIN, senha: process.env.SITE_SENHA } });
  const tela = await api.get(`${SITE}/admin/imovel/`);
  if (tela.url().includes('/admin/login')) throw new Error('login no admin do site falhou (confira SITE_LOGIN/SITE_SENHA)');
  return api;
}

async function pedirAtualizacao(codigo) {
  siteApi = siteApi || await entrarNoSite();
  let tela = await siteApi.get(`${SITE}/admin/imovel/`);
  if (tela.url().includes('/admin/login')) { siteApi = await entrarNoSite(); tela = await siteApi.get(`${SITE}/admin/imovel/`); }
  const r = await siteApi.post(`${SITE}/admin/jetimob/imovel/`, { form: { csrf_test_name: csrfDe(await tela.text()), codigo } });
  return (await r.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// Logo depois do Salvar o Jetimob fica um tempo sem devolver o imóvel na API (processando as fotos),
// e o site entende isso como "saiu do CRM" e DESATIVA o imóvel. Por isso: espera antes e, se vier
// "Desativado", tenta de novo até voltar "Atualizado" (o que reativa o imóvel).
const ESPERAS_SITE = [45, 60, 120, 240, 480];   // segundos antes de cada tentativa

async function atualizarNoSite(codigo, { esperarAntes = true } = {}) {
  let ultimo = '';
  for (const [i, s] of ESPERAS_SITE.entries()) {
    if (esperarAntes || i > 0) await espera(s * 1000);
    ultimo = await pedirAtualizacao(codigo);
    if (/atualizado com sucesso/i.test(ultimo)) return i + 1;
    if (!/desativado/i.test(ultimo)) break;
    console.log(`  … site respondeu "desativado" (Jetimob ainda processando), tentando de novo em ${ESPERAS_SITE[i + 1] || 0}s`);
  }
  throw new Error(`site não confirmou: ${ultimo.slice(0, 200)}${/desativado/i.test(ultimo) ? ' — IMÓVEL PODE ESTAR FORA DO SITE: rode node publicar.js --so-site ' + codigo : ''}`);
}

// Impede duas publicações ao mesmo tempo (cron que dispara enquanto a anterior ainda roda).
const ARQ_TRAVA = path.join(SAIDA, '.publicando');
function pegarTrava() {
  const pid = +lerJson(ARQ_TRAVA, {}).pid || 0;
  if (pid && pid !== process.pid) {
    try { process.kill(pid, 0); return false; } catch { /* processo morreu: trava velha */ }
  }
  fs.writeFileSync(ARQ_TRAVA, JSON.stringify({ pid: process.pid, inicio: new Date().toISOString() }));
  process.on('exit', () => { try { fs.unlinkSync(ARQ_TRAVA); } catch {} });
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));
  return true;
}

// ---------- principal ----------
(async () => {
  if (!TESTE && !SO_SITE && !pegarTrava()) { console.log('Já tem uma publicação em andamento. Saindo.'); return; }

  if (SO_SITE) {
    for (const codigo of CODIGOS) {
      try { await atualizarNoSite(codigo, { esperarAntes: false }); console.log(`✓ site atualizado: ${codigo}`); }
      catch (e) { console.log(`✗ ${codigo}: ${e.message}`); process.exitCode = 1; }
    }
    if (siteApi) await siteApi.dispose();
    return;
  }

  const estado = lerJson(ARQ_ESTADO, {});
  const publicados = lerJson(ARQ_PUBLICADOS, {});
  const rejeitados = new Set(lerLista(ARQ_REJEITADOS));
  const salvarPublicados = () => fs.writeFileSync(ARQ_PUBLICADOS, JSON.stringify(publicados, null, 1));

  let fila = TODOS
    ? Object.keys(estado).filter(c => estado[c].status === 'ok' && (!publicados[c] || (publicados[c].refazer && estado[c].data > publicados[c].data)) && !rejeitados.has(c))
    : CODIGOS;
  fila = fila.filter(c => /^[A-Z]{0,4}\d+$/.test(c));   // só códigos de imóvel (fotos avulsas não têm onde publicar)
  if (MAX) fila = fila.slice(0, MAX);
  // publicados no Jetimob cujo site ainda não confirmou (rodada anterior caiu ou o site recusou)
  const siteAtrasado = TODOS && !TESTE ? Object.keys(publicados).filter(c => !publicados[c].site) : [];
  if (!fila.length && !siteAtrasado.length) {
    console.log('Nada para publicar. Uso: node publicar.js [--teste] <código> ...  ou  --todos');
    return;
  }
  console.log(`[${new Date().toLocaleString('pt-BR')}] ${TESTE ? 'ENSAIO (nada é gravado)' : 'PUBLICANDO'}: ${fila.length} imóvel(is)` +
    (siteAtrasado.length ? `, + ${siteAtrasado.length} esperando o site` : '') + '\n');

  let ok = 0, ultimoSalvar = 0;
  const falhas = [];
  const paraOSite = [...siteAtrasado];
  try {
    // 1. Jetimob: sobe e salva tudo da rodada
    if (fila.length) {
      const ctx = await chromium.launchPersistentContext(PERFIL, { channel: 'chrome', headless: !VER, viewport: { width: 1440, height: 900 }, args: argsChrome() });
      const page = ctx.pages()[0] || await ctx.newPage();
      // "Sair sem salvar?" ao ir para o próximo imóvel depois de uma falha: aceitar (o padrão é ficar
      // na página, e aí todos os imóveis seguintes falhavam em cascata)
      page.on('dialog', d => d.accept().catch(() => {}));
      if (TESTE) {
        // ensaio: bloqueia o que grava no imóvel (envio de foto e salvar); o login passa
        await page.route('**/*', r => {
          const q = r.request();
          const grava = q.method() !== 'GET' && /app\.jetimob\.com\/api\/(upload-image|imoveis\/)/.test(q.url());
          return grava ? r.abort() : r.continue();
        });
      }
      try {
        for (const [i, codigo] of fila.entries()) {
          if (PRAZO && Date.now() > PRAZO) { console.log('Fim da janela de horário; o resto fica para a próxima.'); break; }
          const arquivo = path.join(SAIDA, `${codigo}_card-ia.jpg`);
          if (!fs.existsSync(arquivo)) { console.log(`✗ ${codigo}: não existe ${arquivo}`); falhas.push(codigo); continue; }
          if (!TESTE && !TODOS && publicados[codigo]) console.log(`   aviso: ${codigo} já foi publicado em ${publicados[codigo].data}; publicando de novo`);
          try {
            console.log(`→ [${i + 1}/${fila.length}] ${codigo}...`);
            const r = await publicarUm(page, codigo, arquivo, publicados[codigo]?.urlJetimob);
            if (TESTE) {
              await page.screenshot({ path: path.join(SAIDA, `${codigo}_ensaio-jetimob.png`) });
              console.log(`✓ ${codigo} ensaio ok: ${r.antes} fotos + a nova na frente. Tela em saida/${codigo}_ensaio-jetimob.png`);
            } else {
              ultimoSalvar = Date.now();
              publicados[codigo] = { data: new Date().toISOString(), origemIA: estado[codigo]?.origem || null, urlJetimob: r.urlNova };
              salvarPublicados();
              paraOSite.push(codigo);
              console.log(`✓ ${codigo} publicado no Jetimob (capa nova${r.trocou ? ' no lugar da IA anterior' : ''} + ${r.antes} fotos)`);
            }
            ok++;
          } catch (e) {
            console.log(`✗ ${codigo} ERRO: ${e.message.split('\n')[0]}`);
            await guardarPrint(page, `jetimob-${codigo}`);
            falhas.push(codigo);
          }
          if (i < fila.length - 1) await espera(PAUSA * 1000);
        }
      } finally {
        await ctx.close();
      }
    }

    // 2. Site: só depois que o Jetimob terminou de processar (senão o site desativa o imóvel)
    if (paraOSite.length) {
      const falta = ultimoSalvar ? ESPERAS_SITE[0] * 1000 - (Date.now() - ultimoSalvar) : 0;
      if (falta > 0) { console.log(`\nEsperando ${Math.ceil(falta / 1000)}s o Jetimob processar antes de atualizar o site...`); await espera(falta); }
      for (const codigo of paraOSite) {
        try {
          await atualizarNoSite(codigo, { esperarAntes: false });
          publicados[codigo].site = new Date().toISOString();
          salvarPublicados();
          console.log(`✓ site atualizado: ${codigo}`);
        } catch (e) {
          // fica sem "site" em publicados.json; a próxima rodada tenta de novo
          console.log(`! ${codigo}: ${e.message}`);
          falhas.push(`${codigo} (site)`);
        }
      }
    }
  } finally {
    if (siteApi) await siteApi.dispose();
  }
  console.log(`\n[${new Date().toLocaleString('pt-BR')}] Pronto: ${ok} publicado(s), ${falhas.length} falha(s).${falhas.length ? ' Falharam: ' + falhas.join(', ') : ''}`);
  if (falhas.length) process.exitCode = 1;
})();
