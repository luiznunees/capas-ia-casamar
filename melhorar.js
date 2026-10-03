/*
 * Melhora a foto de capa do imóvel com o ChatGPT (sua conta, sem API) e entrega pronta para o
 * card de destaque do casamarimoveis.net (4:5 — o card mede 352x450 e corta pelo centro).
 *
 * A IA: deixa a foto vertical sem cortar a casa (cria céu em cima e chão embaixo),
 * tira a marca d'água "CASA MAR" e melhora céu, luz, cores e nitidez — sem mudar a construção.
 *
 * Navegador copiado de PROSPECT/sistema/imagens/gerar-chatgpt.js. No Windows usa o MESMO perfil do
 * Chrome do PROSPECT (login já salvo) — não rode os dois ao mesmo tempo: o Chrome trava o perfil.
 *
 * USO:
 *   node melhorar.js --site                 -> todos os imóveis do site: primeiro os condomínios de
 *                                              prioridades.txt (na ordem), depois o resto do sitemap
 *   node melhorar.js                        -> todas as fotos da pasta entrada/
 *   node melhorar.js <url-do-imovel> ...    -> baixa a Foto 1 da página do imóvel no site
 *   node melhorar.js <url-da-imagem|arquivo>
 *   node melhorar.js --login                -> só abre o Chrome para entrar na conta
 *   node melhorar.js --limpar               -> apaga chats antigos criados por estes scripts
 *
 *   --forcar        refaz mesmo se já existir em saida/
 *   --max=N         no máximo N fotos nesta rodada (padrão: sem limite)
 *   --pausa=S       segundos entre fotos (padrão 20, com variação aleatória)
 *   --paralelo=N    quantas fotos ao mesmo tempo, cada uma numa aba (padrão 3)
 *   --manter-chats  não apaga o chat depois de baixar a imagem
 *   --perfil=PASTA  outro perfil do Chrome (ou variável CHATGPT_PERFIL)
 *
 * VPS (Linux, sem tela):
 *   1. No Windows:  node melhorar.js --exportar-sessao      -> cria sessao-chatgpt.json
 *      (o perfil do Chrome do Windows é criptografado e não funciona no Linux; este arquivo sim.
 *       Ele dá acesso à sua conta: não compartilhe nem coloque em git.)
 *   2. Na VPS:      xvfb-run -a node melhorar.js --importar-sessao=sessao-chatgpt.json
 *   3. Cron:        veja instalar-vps.sh
 *   Sem terminal (cron), se a sessão expirar ele para na hora em vez de esperar login.
 *
 * Saída (pasta saida/):
 *   <nome>_card-ia.jpg     foto final 4:5 para o card
 *   <nome>_comparar.jpg    antes x depois, para conferir se a IA não mudou o imóvel
 *   _originais/            foto de entrada e PNG bruto devolvido pelo ChatGPT
 *   estado.json            o que já foi feito e de qual foto; se a capa do imóvel mudar, refaz
 *
 * ATENÇÃO: automatizar o chatgpt.com vai contra os termos da OpenAI. Mantenha o ritmo baixo.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { chromium } = require('playwright');
const { ENTRADA, SAIDA, argsChrome, lerConfig, condominiosDoSite, resolver, alvosOuEntrada, imoveisDoSite, imoveisDoCondominio } = require('./fotos');

// ---------- argumentos ----------
const args = process.argv.slice(2);
const flag = (nome) => args.some(a => a === `--${nome}` || a.startsWith(`--${nome}=`));
const valor = (nome) => (args.find(a => a.startsWith(`--${nome}=`)) || '').split('=').slice(1).join('=') || null;
const ALVOS = args.filter(a => !a.startsWith('--'));
const SO_LOGIN = flag('login');
const LIMPAR = flag('limpar');
const SITE = flag('site');
const FORCAR = flag('forcar');
const MAX = +(valor('max') || 0);              // 0 = sem limite
const PAUSA = +(valor('pausa') || 20);
const PARALELO = Math.max(1, +(valor('paralelo') || 3));
const MANTER_CHATS = flag('manter-chats');
// --ate=<data ISO>: depois disso não pega imóvel novo da fila (janela da madrugada do agendador.js)
const PRAZO = valor('ate') ? Date.parse(valor('ate')) : null;
const EXPORTAR = flag('exportar-sessao') ? (valor('exportar-sessao') || path.join(__dirname, 'sessao-chatgpt.json')) : null;
const IMPORTAR = valor('importar-sessao');
const INTERATIVO = SO_LOGIN || !!EXPORTAR || !!process.stdout.isTTY;

const PERFIL_PROSPECT = 'C:/Users/User/Desktop/PROSPECT/sistema/imagens/perfil-chatgpt';
const PERFIL = valor('perfil') || process.env.CHATGPT_PERFIL
  || (fs.existsSync(PERFIL_PROSPECT) ? PERFIL_PROSPECT : path.join(__dirname, 'perfil-chatgpt'));
const TIMEOUT_IMG = 6 * 60 * 1000;
const PASTA_ORIG = path.join(SAIDA, '_originais');
const ARQ_ESTADO = path.join(SAIDA, 'estado.json');
const ARQ_TRAVA = path.join(SAIDA, '.rodando');
const MAX_TENTATIVAS = 3;   // depois disso a foto só volta se a capa mudar ou com --forcar

// Card: 4:5, nunca mais largo que 1080.
const PROPORCAO_CARD = 4 / 5;
const LARGURA_CARD = 1080;

// O ChatGPT só gera vertical em 2:3 (1024x1536); depois cortamos para 4:5.
const PROMPT = [
  'Edit the attached image. Keep the output in 2:3 aspect ratio (tall vertical portrait).',
  'This is a real estate listing photo.',
  'Recompose it as a vertical image: keep the property fully visible and centered in the frame with comfortable margin on all sides,',
  'so it stays complete even if the image is later cropped to a square,',
  'and naturally extend the surroundings (sky above, lawn, pavement or floor below) so no part of the property is cut off.',
  'Keep the architecture exactly as in the original: same shape, proportions, materials, windows, doors, colors, landscaping and neighbors.',
  'Do not add, remove or invent any building elements, furniture, people, cars or objects.',
  'Remove the "CASA MAR imóveis" logo watermark completely, filling the area naturally.',
  'Enhance it like a professional real estate photographer: clean natural blue sky with soft clouds, balanced exposure, lifted shadows,',
  'true-to-life vivid colors, crisp sharp details.',
  'Do not ask questions, just create the image. Do not add any text in the image.',
].join(' ');

const espera = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- navegador ----------
async function abrirNavegador() {
  const ctx = await chromium.launchPersistentContext(PERFIL, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    args: ['--disable-blink-features=AutomationControlled', '--start-maximized', ...argsChrome()],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  const page = ctx.pages()[0] || await ctx.newPage();
  return { ctx, page };
}

// O site muda os seletores com frequência; a sessão da conta é o sinal mais estável.
const SELETOR_CAIXA = '#prompt-textarea, div[contenteditable="true"][role="textbox"], div.ProseMirror[contenteditable="true"], textarea[name="prompt-textarea"]';
const SELETOR_ENVIAR = '[data-testid="send-button"], button[aria-label*="Enviar" i], button[aria-label*="Send" i]';

async function logado(page) {
  const sessao = await page.evaluate(async () => {
    try {
      const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
      return !!s?.accessToken;
    } catch { return false; }
  }).catch(() => false);
  if (sessao) return true;
  const caixa = await page.locator(SELETOR_CAIXA).count();
  const botaoLogin = await page.locator('[data-testid="login-button"]').count();
  return caixa > 0 && botaoLogin === 0;
}

// Depois de um erro: o login só "caiu" se continuar sem sessão após recarregar, 3 vezes.
async function loginConfirmado(page) {
  for (let i = 0; i < 3; i++) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
    await espera(4000 + i * 6000);
    if (await logado(page).catch(() => false)) return true;
  }
  return false;
}

async function garantirLogin(page) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  await espera(4000);
  if (await logado(page)) return;
  if (!INTERATIVO) {
    throw new Error('Não está logado no ChatGPT. Exporte a sessão de novo no Windows (--exportar-sessao) e importe aqui (--importar-sessao=...).');
  }
  console.log('>> Faça login no ChatGPT na janela do Chrome que abriu. Espero até 10 minutos...');
  const fim = Date.now() + 10 * 60 * 1000;
  while (Date.now() < fim) {
    await espera(3000);
    if (await logado(page).catch(() => false)) { console.log('>> Login ok, fica salvo para as próximas vezes.\n'); return; }
  }
  throw new Error('Não detectei o login a tempo.');
}

// ---------- apagar chats ----------
// Mesmo começo de prompt do gerar-chatgpt.js: o --limpar de qualquer um dos dois reconhece os chats.
const INICIOS_PROMPT = ['Generate one photorealistic image, aspect ratio', 'Edit the attached image. Keep the output in'];

async function apagarPelaApi(page, id) {
  return page.evaluate(async (id) => {
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json()).catch(() => ({}));
    if (!s.accessToken) return 'sem token';
    const r = await fetch(`/backend-api/conversation/${id}`, {
      method: 'PATCH',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${s.accessToken}` },
      body: JSON.stringify({ is_visible: false }),
    });
    return r.ok ? 'ok' : `HTTP ${r.status}`;
  }, id);
}

// Plano B: clica em "..." > Excluir > confirmar, como uma pessoa faria.
async function apagarPelaTela(page, id) {
  await page.goto(`https://chatgpt.com/c/${id}`, { waitUntil: 'domcontentloaded' });
  await espera(3000);
  const opcoes = page.locator([
    '[data-testid="conversation-options-button"]',
    'button[aria-label="Open conversation options"]',
    'button[aria-label*="conversation options" i]',
    'button[aria-label*="opções da conversa" i]',
  ].join(', ')).first();
  await opcoes.click({ timeout: 10000 });
  await page.getByRole('menuitem', { name: /delete|excluir|eliminar|apagar/i }).first().click({ timeout: 10000 });
  await page.locator('[data-testid="delete-conversation-confirm-button"]')
    .or(page.getByRole('button', { name: /^(delete|excluir|eliminar|apagar)$/i }))
    .first().click({ timeout: 10000 });
  await espera(1500);
  return 'ok';
}

async function apagarChat(page, id) {
  const r = await apagarPelaApi(page, id).catch(e => e.message);
  if (r === 'ok') return 'ok';
  const r2 = await apagarPelaTela(page, id).catch(e => `tela: ${e.message.split('\n')[0]}`);
  return r2 === 'ok' ? 'ok' : `api: ${r} / ${r2}`;
}

function idDoChat(page) {
  return (page.url().match(/\/c\/([0-9a-f-]{36})/) || [])[1] || null;
}

async function limparChatsAntigos(page) {
  const encontrados = await page.evaluate(async (inicios) => {
    const s = await fetch('/api/auth/session', { credentials: 'include' }).then(r => r.json());
    const H = { Authorization: `Bearer ${s.accessToken}` };
    const nossos = [];
    let visto = 0;
    for (let offset = 0; offset < 1000; offset += 100) {
      const lista = await fetch(`/backend-api/conversations?offset=${offset}&limit=100&order=updated`, { headers: H }).then(r => r.json());
      const itens = lista.items || [];
      for (const c of itens) {
        visto++;
        // confere a 1ª mensagem do usuário — o título sozinho não é confiável
        const conv = await fetch(`/backend-api/conversation/${c.id}`, { headers: H }).then(r => r.json()).catch(() => null);
        const primeira = Object.values(conv?.mapping || {})
          .map(n => n.message)
          .filter(m => m?.author?.role === 'user')
          .sort((a, b) => (a.create_time || 0) - (b.create_time || 0))[0];
        const texto = (primeira?.content?.parts || []).filter(p => typeof p === 'string').join(' ').trim();
        if (inicios.some(i => texto.startsWith(i))) nossos.push({ id: c.id, titulo: c.title });
      }
      if (itens.length < 100) break;
    }
    return { nossos, visto };
  }, INICIOS_PROMPT);

  if (!encontrados.nossos.length) { console.log(`Nenhum chat antigo para apagar (${encontrados.visto} conferidos).`); return; }
  console.log(`${encontrados.visto} chats conferidos, ${encontrados.nossos.length} criados pelos scripts. Apagando...`);
  let apagados = 0;
  for (const c of encontrados.nossos) {
    const r = await apagarChat(page, c.id);
    if (r === 'ok') apagados++;
    else console.log(`   não apaguei "${c.titulo}": ${r}`);
    await espera(400);
  }
  console.log(`Apagados: ${apagados}.`);
}

// ---------- uma imagem ----------
async function editarNoChatGPT(page, arqFoto) {
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' });
  const caixa = page.locator(SELETOR_CAIXA).first();
  await caixa.waitFor({ timeout: 60000 });
  await espera(1500);

  await page.locator('input[type="file"]').first().setInputFiles(arqFoto);
  await espera(3000);

  await caixa.click();
  await page.keyboard.insertText(PROMPT);
  await espera(800);

  // espera o botão de enviar liberar (upload da foto terminar)
  const enviar = page.locator(SELETOR_ENVIAR).first();
  if (await enviar.waitFor({ timeout: 20000 }).then(() => true, () => false)) {
    for (let i = 0; i < 60 && await enviar.isDisabled(); i++) await espera(1000);
    await enviar.click();
  } else {
    // sem botão reconhecível: Enter envia a mensagem no editor do ChatGPT
    await caixa.click();
    await page.keyboard.press('Enter');
  }

  // o ChatGPT só troca a URL para /c/<id> depois de criar a conversa
  await page.waitForURL(/\/c\/[0-9a-f-]{36}/, { timeout: 60000 }).catch(() => {});
  const idChat = idDoChat(page);

  try {
    return await esperarEBaixar(page);
  } finally {
    if (!MANTER_CHATS) {
      const r = idChat ? await apagarChat(page, idChat).catch(e => e.message) : 'id do chat não encontrado na URL';
      console.log(r === 'ok' ? `   chat ${idChat.slice(0, 8)} apagado` : `   (aviso: chat não apagado — ${r})`);
    }
  }
}

async function esperarEBaixar(page) {
  // espera a resposta: imagem grande na última resposta e geração encerrada
  const inicio = Date.now();
  await espera(5000);
  let srcAnterior = null, estavel = 0;
  while (Date.now() - inicio < TIMEOUT_IMG) {
    const estado = await page.evaluate(() => {
      // Última resposta do ChatGPT. O atributo de autor é o sinal mais estável do site.
      const raiz = document.querySelector('main') || document.body;
      const respostas = [...raiz.querySelectorAll('[data-message-author-role="assistant"]')];
      const ultima = respostas[respostas.length - 1];
      let turno = ultima ? (ultima.closest('article, [data-testid^="conversation-turn"]') || ultima.parentElement?.parentElement || ultima) : null;
      if (!turno) {
        const turnos = [...raiz.querySelectorAll('article, [data-testid^="conversation-turn"]')]
          .filter(t => !t.querySelector('[data-message-author-role="user"]'));
        turno = turnos[turnos.length - 1] || null;
      }
      // A foto enviada também é uma imagem grande: só vale imagem da resposta, e nunca uma que
      // apareça na mensagem do usuário (antes havia um "plano B" que pegava qualquer imagem da
      // página e, quando o ChatGPT não gerava nada, devolvia a própria foto original).
      const daMensagemDoUsuario = new Set([...raiz.querySelectorAll('[data-message-author-role="user"] img')].map(i => i.src));
      let imgs = turno ? [...turno.querySelectorAll('img')] : [];
      imgs = imgs.filter(i => i.naturalWidth >= 512 && i.complete && !i.closest('[data-message-author-role="user"]') && !daMensagemDoUsuario.has(i.src));
      const textoPagina = raiz.innerText || '';
      const gerando = !!document.querySelector('[data-testid="stop-button"], button[aria-label*="Parar" i], button[aria-label*="Stop" i]')
        || /criando imagem|gerando imagem|creating image|generating image/i.test(textoPagina);
      return {
        src: imgs.length ? imgs[imgs.length - 1].src : null,
        gerando,
        texto: ((turno && turno.innerText) || '').slice(0, 400),
      };
    });

    if (estado.src && !estado.gerando) {
      estavel = estado.src === srcAnterior ? estavel + 1 : 0;
      srcAnterior = estado.src;
      if (estavel >= 2) break; // mesma imagem por ~5s e sem botão de parar: terminou
    }
    if (!estado.src && !estado.gerando && Date.now() - inicio > 30000) {
      const t = (estado.texto || '').toLowerCase();
      if (/limit|límite|limite|try again later|tente novamente|upgrade|plus/.test(t)) {
        const e = new Error('LIMITE: ' + estado.texto.replace(/\s+/g, ' ').slice(0, 200));
        e.limite = true;
        throw e;
      }
      // A geração de imagem pode levar mais de 1 minuto; só desiste depois de 4.
      if (Date.now() - inicio > 240000) {
        await page.screenshot({ path: path.join(SAIDA, 'debug-ultimo-erro.png') }).catch(() => {});
        throw new Error('Resposta sem imagem (tela salva em saida/debug-ultimo-erro.png): ' + (estado.texto || '').replace(/\s+/g, ' ').slice(0, 200));
      }
    }
    await espera(2500);
  }
  if (!srcAnterior) {
    await page.screenshot({ path: path.join(SAIDA, 'debug-ultimo-erro.png') }).catch(() => {});
    throw new Error('Tempo esgotado esperando a imagem (tela salva em saida/debug-ultimo-erro.png)');
  }

  // baixa a imagem pelo próprio navegador (usa a sessão logada)
  const b64 = await page.evaluate(async (src) => {
    const r = await fetch(src, { credentials: 'include' });
    const buf = new Uint8Array(await r.arrayBuffer());
    let s = '';
    for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  }, srcAnterior);

  return Buffer.from(b64, 'base64');
}

// ---------- pós-processamento ----------
// O "resultado" é a própria foto enviada? (o ChatGPT não gerou e a tela só mostrava o anexo)
// Mesmas dimensões, ou quase idêntica em miniatura 48x48 cinza (a da IA é recomposta, muda bastante).
async function pareceAOriginal(bruto, original) {
  const [mb, mo] = await Promise.all([sharp(bruto).metadata(), sharp(original).rotate().metadata()]);
  const larguraO = mo.autoOrient?.width ?? mo.width, alturaO = mo.autoOrient?.height ?? mo.height;
  if (mb.width === larguraO && mb.height === alturaO) return true;
  const mini = (b) => sharp(b).rotate().resize(48, 48, { fit: 'fill' }).grayscale().raw().toBuffer();
  const [a, o] = await Promise.all([mini(bruto), mini(original)]);
  let soma = 0;
  for (let i = 0; i < a.length; i++) soma += Math.abs(a[i] - o[i]);
  return soma / a.length < 8;
}

// Fotos já marcadas "ok" que na verdade são a original (gravadas antes desta checagem existir):
// volta para a fila e, se já foi publicada, marca para publicar de novo por cima.
async function revisarResultadosAntigos(estado, publicados, salvarEstado) {
  const suspeitos = [];
  for (const [nome, e] of Object.entries(estado)) {
    if (e.status !== 'ok' || e.revisado) continue;
    const arqIA = path.join(PASTA_ORIG, `${nome}_ia.png`), arqAntes = path.join(PASTA_ORIG, `${nome}_antes.png`);
    if (!fs.existsSync(arqIA) || !fs.existsSync(arqAntes)) continue;
    if (await pareceAOriginal(fs.readFileSync(arqIA), fs.readFileSync(arqAntes)).catch(() => false)) {
      estado[nome] = { origem: e.origem, status: 'erro', tentativas: 0, erro: 'IA devolveu a foto original; refazer', data: new Date().toISOString() };
      suspeitos.push(nome);
    } else {
      e.revisado = true;
    }
  }
  salvarEstado();
  if (suspeitos.length) {
    const arqPub = path.join(SAIDA, 'publicados.json');
    const pubs = JSON.parse(fs.readFileSync(arqPub, 'utf8') || '{}');
    for (const nome of suspeitos) if (pubs[nome]) pubs[nome].refazer = true;
    fs.writeFileSync(arqPub + '.tmp', JSON.stringify(pubs, null, 1));
    fs.renameSync(arqPub + '.tmp', arqPub);
    Object.assign(publicados, pubs);
    console.log(`   ${suspeitos.length} foto(s) antiga(s) eram a original, voltaram para a fila: ${suspeitos.join(', ')}`);
  }
  return suspeitos;
}
async function cortarParaCard(bruto) {
  const meta = await sharp(bruto).metadata();
  const largura = Math.min(LARGURA_CARD, meta.width, Math.round(meta.height * PROPORCAO_CARD));
  const altura = Math.round(largura / PROPORCAO_CARD);
  return sharp(bruto)
    .resize(largura, altura, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 85, mozjpeg: true, progressive: true })
    .toBuffer();
}

// Antes (como o site mostra hoje: corte central 4:5) x depois, lado a lado na altura do card x2.
async function montarComparacao(original, card, destino) {
  const A = 900, L = Math.round(A * PROPORCAO_CARD), GAP = 20;
  const antes = await sharp(original).resize(L, A, { fit: 'cover', position: 'centre' }).toBuffer();
  const depois = await sharp(card).resize(L, A, { fit: 'cover' }).toBuffer();
  await sharp({ create: { width: L * 2 + GAP, height: A, channels: 3, background: '#ffffff' } })
    .composite([{ input: antes, left: 0, top: 0 }, { input: depois, left: L + GAP, top: 0 }])
    .jpeg({ quality: 80 })
    .toFile(destino);
}

// ---------- fila, estado e trava ----------
function lerJson(arq, padrao) {
  try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; }
}

// Condomínios prioritários (lista editada no painel; padrão prioridades.txt), depois o resto do sitemap.
// Grava saida/fila.json com quem é de qual condomínio, para a visão geral do painel.
async function filaDoSite() {
  const fila = [];
  const vistos = new Set();
  const adicionar = (u) => { if (!vistos.has(u)) { vistos.add(u); fila.push(u); } };
  const codigoDe = (u) => (u.match(/\/imovel\/(\d+)\//) || [])[1];
  const cidades = new Map((await condominiosDoSite().catch(() => [])).map(c => [c.slug, c.cidade]));
  const porCondominio = {};
  for (const slug of lerConfig().prioridades) {
    const urls = await imoveisDoCondominio(slug, cidades.get(slug)).catch(e => { console.log(`   (aviso: condomínio ${slug}: ${e.message})`); return []; });
    console.log(`   prioridade ${slug}: ${urls.length} imóveis`);
    porCondominio[slug] = urls.map(codigoDe);
    urls.forEach(adicionar);
  }
  const prioritarios = fila.length;
  (await imoveisDoSite()).forEach(adicionar);
  console.log(`   ${prioritarios} prioritários + ${fila.length - prioritarios} restantes do site`);
  fs.writeFileSync(path.join(SAIDA, 'fila.json'), JSON.stringify({ em: new Date().toISOString(), total: fila.length, prioritarios, porCondominio }));
  return fila;
}

// Impede duas rodadas ao mesmo tempo (cron que dispara enquanto a anterior ainda roda).
function pegarTrava() {
  const pid = +lerJson(ARQ_TRAVA, {}).pid || 0;
  if (pid && pid !== process.pid) {
    try { process.kill(pid, 0); return false; } catch { /* processo morreu: trava velha */ }
  }
  fs.writeFileSync(ARQ_TRAVA, JSON.stringify({ pid: process.pid, inicio: new Date().toISOString() }));
  return true;
}
const soltarTrava = () => { try { fs.unlinkSync(ARQ_TRAVA); } catch {} };

// Pedidos do painel (painel.js) enquanto uma rodada já está aberta: uma URL de imóvel por linha.
const ARQ_URGENTE = path.join(SAIDA, 'urgente.txt');
function pegarUrgente() {
  const linhas = fs.existsSync(ARQ_URGENTE) ? fs.readFileSync(ARQ_URGENTE, 'utf8').split(/\r?\n/).filter(Boolean) : [];
  if (!linhas.length) return null;
  fs.writeFileSync(ARQ_URGENTE, linhas.slice(1).map(l => l + '\n').join(''));
  return linhas[0].trim();
}

// ---------- principal ----------
(async () => {
  fs.mkdirSync(PASTA_ORIG, { recursive: true });
  const soNavegador = SO_LOGIN || LIMPAR || EXPORTAR || IMPORTAR;
  if (!soNavegador) {
    if (!pegarTrava()) { console.log('Já tem uma rodada em andamento. Saindo.'); return; }
    process.on('exit', soltarTrava);
  }
  process.on('SIGINT', () => process.exit(130));
  process.on('SIGTERM', () => process.exit(143));

  let alvos = [];
  if (!soNavegador) {
    console.log(`[${new Date().toLocaleString('pt-BR')}] Montando a fila...`);
    alvos = SITE ? await filaDoSite() : alvosOuEntrada(ALVOS);
    if (!alvos.length) { console.log(`Nada para processar. Coloque fotos em ${ENTRADA}, passe URLs ou use --site.`); return; }
  }

  let ctx, page;
  try {
    ({ ctx, page } = await abrirNavegador());
  } catch (e) {
    console.error(`Não consegui abrir o Chrome com o perfil ${PERFIL}.`);
    console.error('Se outro Chrome com esse perfil estiver aberto, feche e rode de novo. No Linux sem tela, use xvfb-run -a.');
    console.error(e.message.split('\n')[0]);
    process.exitCode = 1;
    return;
  }

  try {
    if (IMPORTAR) {
      const sessao = lerJson(IMPORTAR, null);
      if (!sessao?.cookies) throw new Error(`Arquivo de sessão inválido: ${IMPORTAR}`);
      await ctx.addCookies(sessao.cookies);
      console.log(`Sessão importada (${sessao.cookies.length} cookies).`);
    }
    await garantirLogin(page);
    if (EXPORTAR) {
      await ctx.storageState({ path: EXPORTAR });
      console.log(`Sessão salva em ${EXPORTAR}.`);
      console.log('Envie este arquivo no painel (Easypanel): "Login do ChatGPT" > "Enviar sessao-chatgpt.json". Não compartilhe: ele dá acesso à sua conta.');
      return;
    }
    if (IMPORTAR || SO_LOGIN) { console.log('Login pronto.'); return; }
    if (LIMPAR) { await limparChatsAntigos(page); return; }

    const estado = lerJson(ARQ_ESTADO, {});
    const publicados = lerJson(path.join(SAIDA, 'publicados.json'), {});
    // grava e renomeia: o publicar.js lê este arquivo enquanto esta rodada escreve
    const salvarEstado = () => {
      fs.writeFileSync(ARQ_ESTADO + '.tmp', JSON.stringify(estado, null, 1));
      fs.renameSync(ARQ_ESTADO + '.tmp', ARQ_ESTADO);
    };

    // fotos "ok" antigas que eram a original voltam para a frente da fila
    if (SITE) {
      const refazer = await revisarResultadosAntigos(estado, publicados, salvarEstado);
      const urls = new Map(alvos.map(u => [(u.match(/\/imovel\/(\d+)\//) || [])[1], u]));
      const daFrente = refazer.map(c => urls.get(c)).filter(Boolean);
      alvos = [...daFrente, ...alvos.filter(u => !daFrente.includes(u))];
    }

    console.log(`${alvos.length} na fila, ${PARALELO} aba(s) ao mesmo tempo${MAX ? `, no máximo ${MAX} nesta rodada` : ''}.\n`);
    let ok = 0, feitas = 0, puladas = 0, proximo = 0, parar = false;
    const falhas = [];

    async function processar(aba, alvo, i, forcar = FORCAR) {
      let nome = alvo;
      try {
        const foto = await resolver(alvo, i);
        nome = foto.nome;
        const destino = path.join(SAIDA, `${nome}_card-ia.jpg`);
        // já publicado no Jetimob: a capa do site agora é a própria foto da IA, não reprocessar
        if (!forcar && publicados[nome] && !publicados[nome].refazer) { puladas++; return false; }
        const anterior = estado[nome];
        const mesmaFoto = anterior?.origem === foto.origem;
        if (!forcar && mesmaFoto && anterior.status === 'ok' && fs.existsSync(destino)) { puladas++; return false; }
        if (!forcar && mesmaFoto && anterior.status === 'erro' && anterior.tentativas >= MAX_TENTATIVAS) { puladas++; return false; }
        if (!forcar && mesmaFoto && anterior.status === 'ja-ia') { puladas++; return false; }
        if (MAX && feitas >= MAX) { parar = true; return false; }
        const n = ++feitas;

        // Já publicado: a Foto 1 do site agora é a própria foto da IA. Gera de novo a partir da original guardada.
        const arqEntrada = path.join(PASTA_ORIG, `${nome}_antes.png`);
        let original, origem = foto.origem;
        if (publicados[nome]) {
          if (!fs.existsSync(arqEntrada)) throw new Error('já publicado e a foto original não está em saida/_originais; não dá para gerar de novo');
          original = fs.readFileSync(arqEntrada);
          origem = anterior?.origem || origem;
        } else {
          original = await foto.ler();
          // Capa em 1024x1280 é o tamanho exato que esta automação publica: a capa já é uma foto nossa
          // (o registro de publicação se perdeu ou veio de outra máquina). Gerar em cima dela seria IA da IA.
          const dims = await sharp(original).metadata();
          if (dims.width === 1024 && dims.height === 1280) {
            feitas--;
            estado[nome] = { origem, status: 'ja-ia', data: new Date().toISOString() };
            salvarEstado();
            console.log(`- ${nome}: a capa do site já é uma foto da IA (1024x1280), pulando`);
            puladas++;
            return false;
          }
          // o ChatGPT aceita melhor JPG/PNG; webp vira PNG
          await sharp(original).rotate().png().toFile(arqEntrada);
        }

        console.log(`→ [${n}] ${nome} enviando para o ChatGPT...`);
        const t0 = Date.now();
        let bruto;
        try {
          bruto = await editarNoChatGPT(aba, arqEntrada);
          if (await pareceAOriginal(bruto, original)) throw new Error('o ChatGPT não gerou imagem nova (veio a própria foto original)');
        } catch (e) {
          estado[nome] = { origem, status: 'erro', tentativas: (mesmaFoto ? anterior.tentativas || 0 : 0) + 1, erro: e.message.slice(0, 300), data: new Date().toISOString() };
          salvarEstado();
          throw e;
        }

        fs.writeFileSync(path.join(PASTA_ORIG, `${nome}_ia.png`), await sharp(bruto).png().toBuffer());
        const card = await cortarParaCard(bruto);
        fs.writeFileSync(destino, card);
        await montarComparacao(original, card, path.join(SAIDA, `${nome}_comparar.jpg`));
        estado[nome] = { origem, status: 'ok', data: new Date().toISOString() };
        salvarEstado();

        const m = await sharp(card).metadata();
        ok++;
        console.log(`✓ [${n}] ${nome} ok (${Math.round((Date.now() - t0) / 1000)}s) -> ${m.width}x${m.height}`);
      } catch (e) {
        console.log(`✗ ${nome} ERRO: ${e.message}`);
        falhas.push(nome);
        if (e.limite && !parar) { parar = true; console.log('\nLimite do ChatGPT atingido. Rode de novo mais tarde que ele continua de onde parou.'); }
        // sessão caiu no meio da rodada: não adianta seguir (confere com calma antes: um erro
        // qualquer no meio de um chat não quer dizer que o login caiu)
        else if (!parar && !(await loginConfirmado(aba))) { parar = true; console.log('\nSessão do ChatGPT caiu. Parando.'); }
      }
      return true;
    }

    // Cada aba pega o próximo da fila; as já feitas são puladas sem pausa.
    const abas = [page];
    while (abas.length < Math.min(PARALELO, alvos.length)) abas.push(await ctx.newPage());
    await Promise.all(abas.map(async (aba, n) => {
      if (n > 0) await espera(n * 4000); // não dispara todas no mesmo segundo
      while (!parar) {
        // pedido do painel tem prioridade sobre a fila (e sempre refaz)
        const urgente = pegarUrgente();
        if (urgente) {
          console.log(`→ pedido do painel: ${urgente}`);
          if (await processar(aba, urgente, -1, true) && !parar) await espera(PAUSA * 1000);
          continue;
        }
        if (proximo >= alvos.length) break;
        if (PRAZO && Date.now() > PRAZO) {
          if (!parar) console.log(`\n[${new Date().toLocaleString('pt-BR')}] Fim da janela de horário; continua na próxima.`);
          parar = true;
          break;
        }
        const i = proximo++;
        const usouChatGPT = await processar(aba, alvos[i], i);
        if (usouChatGPT && !parar && proximo < alvos.length) await espera((PAUSA + Math.random() * PAUSA * 0.6) * 1000);
      }
    }));
    if (MAX && feitas >= MAX && proximo < alvos.length) console.log(`\nLimite de ${MAX} por rodada. Rode de novo para continuar.`);
    console.log(`\n[${new Date().toLocaleString('pt-BR')}] Pronto: ${ok} ok, ${falhas.length} falha(s), ${puladas} já feitas/puladas. Confira os *_comparar.jpg antes de publicar.`);
    if (falhas.length) process.exitCode = 1;
  } catch (e) {
    console.error('Erro:', e.message);
    process.exitCode = 1;
  } finally {
    await ctx.close();
  }
})();
