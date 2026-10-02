// Funções comuns: de onde vêm as fotos (pasta entrada/, arquivo local, página do imóvel, URL direta ou o site todo).

const fs = require('fs');
const path = require('path');

// No Docker (Easypanel) os dados ficam num volume: DADOS_DIR=/dados. Local: a própria pasta.
const DADOS = process.env.DADOS_DIR || __dirname;
const ENTRADA = path.join(DADOS, 'entrada');
const SAIDA = path.join(DADOS, 'saida');
const EXTENSOES = ['.jpg', '.jpeg', '.png', '.webp'];
const SITEMAP = 'https://www.casamarimoveis.net/sitemap.xml';

async function baixar(url) {
  const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ao baixar ${url}`);
  return resp;
}

const baixarBuffer = async (url) => Buffer.from(await (await baixar(url)).arrayBuffer());

// Página do imóvel: a Foto 1 (a mesma usada no card) é o primeiro link da galeria.
async function fotoCapaDoImovel(urlPagina) {
  const html = await (await baixar(urlPagina)).text();
  const m = html.match(/<a href="(https:\/\/s01\.jetimgs\.com\/[^"]+)"[^>]*data-fancybox="fotos"/);
  if (!m) throw new Error(`Foto 1 não encontrada em ${urlPagina}`);
  const codigo = (urlPagina.match(/\/imovel\/(\d+)\//) || [])[1] || 'imovel';
  return { url: m[1], nome: codigo };
}

// Descobre nome e origem da foto sem baixá-la; `ler()` baixa/lê só quando for usar.
// `origem` muda quando a foto muda (outra URL de capa, ou arquivo local modificado).
async function resolver(alvo, indice) {
  if (/^https?:\/\//.test(alvo)) {
    if (alvo.includes('casamarimoveis.net/imovel/')) {
      const capa = await fotoCapaDoImovel(alvo);
      return { nome: capa.nome, origem: capa.url, ler: () => baixarBuffer(capa.url) };
    }
    return { nome: `foto-${indice + 1}`, origem: alvo, ler: () => baixarBuffer(alvo) };
  }
  const mtime = fs.statSync(alvo).mtimeMs;
  return { nome: path.parse(alvo).name, origem: `${path.resolve(alvo)}@${mtime}`, ler: async () => fs.readFileSync(alvo) };
}

async function carregar(alvo, indice) {
  const r = await resolver(alvo, indice);
  return { buffer: await r.ler(), nome: r.nome };
}

// Sem alvos na linha de comando: todas as imagens da pasta entrada/.
function alvosOuEntrada(alvos) {
  if (alvos.length) return alvos;
  fs.mkdirSync(ENTRADA, { recursive: true });
  return fs.readdirSync(ENTRADA)
    .filter((f) => EXTENSOES.includes(path.extname(f).toLowerCase()))
    .map((f) => path.join(ENTRADA, f));
}

// Todas as páginas de imóvel do site, pelo sitemap (índice -> sitemaps -> URLs /imovel/).
async function imoveisDoSite() {
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const sitemaps = locs(await (await baixar(SITEMAP)).text());
  const urls = new Set();
  for (const s of sitemaps) {
    for (const u of locs(await (await baixar(s)).text())) if (u.includes('/imovel/')) urls.add(u);
  }
  return [...urls];
}

// Imóveis de um condomínio, pela busca do site (sem cidade e modo a busca ignora o filtro).
// Pára quando uma página não traz imóvel novo: a busca repete a última página em vez de dar 404.
async function imoveisDoCondominio(slug, cidade = 'xangri-la') {
  const urls = new Set();
  for (let pagina = 1; pagina <= 100; pagina++) {
    const html = await (await baixar(`https://www.casamarimoveis.net/busca/comprar/cidade/${cidade}/condominios/${slug}/${pagina}/`)).text();
    const daPagina = [...html.matchAll(/href="(https:\/\/www\.casamarimoveis\.net\/imovel\/[^"]+)"/g)].map((m) => m[1]);
    const antes = urls.size;
    daPagina.forEach((u) => urls.add(u));
    if (urls.size === antes) break;
  }
  return [...urls];
}

// Página do imóvel no site a partir do código (a busca por código também traz parecidos: filtra o exato).
// Sem o modo na URL a busca não acha todos; tenta comprar, alugar e por último sem modo.
async function urlDoImovel(codigo) {
  const exato = new RegExp(`https://www\\.casamarimoveis\\.net/imovel/${codigo}/[^"'\\s]+`);
  for (const modo of ['comprar/', 'alugar/', '']) {
    const html = await (await baixar(`https://www.casamarimoveis.net/busca/${modo}codigo/${codigo}/1/`)).text();
    const m = html.match(exato);
    if (m) return m[0];
  }
  return null;
}

// Chrome dentro de container: /dev/shm pequeno e usuário root precisam destas opções.
function argsChrome() {
  const a = ['--disable-dev-shm-usage'];
  if (typeof process.getuid === 'function' && process.getuid() === 0) a.push('--no-sandbox');
  return a;
}

// Condomínios do site (filtro da busca da home): [{ slug, nome, cidade }].
async function condominiosDoSite() {
  const html = await (await baixar('https://www.casamarimoveis.net/')).text();
  const lista = [];
  const visto = new Set();
  for (const m of html.matchAll(/name="condominios\[\]" id="condominios([^"]+)" value="([^"]+)"[^>]*>\s*<label[^>]*>([^<]+)/g)) {
    const [, id, slug, nome] = m;
    if (visto.has(slug)) continue;
    visto.add(slug);
    // id = condominios<cidade><número><slug>
    lista.push({ slug, nome: nome.trim(), cidade: (id.match(/^(.*?)\d+/) || [, 'xangri-la'])[1] });
  }
  return lista;
}

// ---------- configuração editável pelo painel (DADOS/config.json) ----------
// Variáveis de ambiente são o padrão; o que for salvo pelo painel vale por cima delas.
const ARQ_CONFIG = path.join(DADOS, 'config.json');
function padroesConfig() {
  const arqPrio = path.join(__dirname, 'prioridades.txt');
  const prioridades = fs.existsSync(arqPrio)
    ? fs.readFileSync(arqPrio, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))
    : [];
  return {
    iaAutomatica: process.env.IA_AUTOMATICA !== 'nao',
    publicarAutomatico: process.env.PUBLICAR_AUTOMATICO !== 'nao',
    janelaInicio: +(process.env.JANELA_INICIO ?? 0),
    janelaFim: +(process.env.JANELA_FIM ?? 6),
    paralelo: +(process.env.PARALELO || 3),
    prioridades,
    alertas: {
      url: process.env.EVOLUTION_URL || '',
      instancia: process.env.EVOLUTION_INSTANCIA || '',
      apikey: process.env.EVOLUTION_APIKEY || '',
      numero: process.env.WHATSAPP_NUMERO || '',
      resumo: true,
      falhas: true,
    },
  };
}
function lerConfig() {
  const p = padroesConfig();
  let salvo = {};
  try { salvo = JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8')); } catch {}
  return { ...p, ...salvo, alertas: { ...p.alertas, ...(salvo.alertas || {}) } };
}
function salvarConfig(parcial) {
  let salvo = {};
  try { salvo = JSON.parse(fs.readFileSync(ARQ_CONFIG, 'utf8')); } catch {}
  const novo = { ...salvo, ...parcial };
  if (parcial.alertas) novo.alertas = { ...(salvo.alertas || {}), ...parcial.alertas };
  fs.mkdirSync(DADOS, { recursive: true });
  fs.writeFileSync(ARQ_CONFIG + '.tmp', JSON.stringify(novo, null, 1));
  fs.renameSync(ARQ_CONFIG + '.tmp', ARQ_CONFIG);
  return lerConfig();
}

// Sessão do ChatGPT exportada no Windows (melhorar.js --exportar-sessao), enviada pelo painel.
// "Pendente" = arquivo mais novo que a última importação; o agendador importa antes da próxima rodada.
const ARQ_SESSAO = path.join(DADOS, 'sessao-chatgpt.json');
const MARCA_SESSAO = path.join(DADOS, 'sessao-chatgpt.importada');
const mtime = (arq) => { try { return fs.statSync(arq).mtimeMs; } catch { return 0; } };
const sessao = {
  arquivo: ARQ_SESSAO,
  pendente: () => mtime(ARQ_SESSAO) > mtime(MARCA_SESSAO),
  marcarImportada: () => fs.writeFileSync(MARCA_SESSAO, new Date().toISOString()),
  datas: () => ({ enviada: mtime(ARQ_SESSAO) || null, importada: mtime(MARCA_SESSAO) || null }),
};

module.exports = { DADOS, ENTRADA, SAIDA, argsChrome, sessao, lerConfig, salvarConfig, condominiosDoSite, baixar, resolver, carregar, alvosOuEntrada, imoveisDoSite, imoveisDoCondominio, urlDoImovel };
