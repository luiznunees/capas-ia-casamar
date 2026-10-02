// Números da automação: usados na visão geral do painel e no resumo da madrugada (WhatsApp).

const fs = require('fs');
const path = require('path');
const { DADOS, SAIDA } = require('./fotos');

const lerJson = (arq, padrao) => { try { return JSON.parse(fs.readFileSync(arq, 'utf8')); } catch { return padrao; } };
const dia = (iso) => new Date(iso).toLocaleDateString('sv-SE');   // AAAA-MM-DD no fuso do container

function rejeitados() {
  const arq = path.join(DADOS, 'rejeitados.txt');
  return fs.existsSync(arq) ? fs.readFileSync(arq, 'utf8').split(/\r?\n/).map(l => l.trim()).filter(l => /^\d+$/.test(l)) : [];
}

// desde (ISO, opcional): conta também o que aconteceu a partir dali (ex.: início da madrugada)
function resumo({ desde } = {}) {
  const estado = lerJson(path.join(SAIDA, 'estado.json'), {});
  const publicados = lerJson(path.join(SAIDA, 'publicados.json'), {});
  const fila = lerJson(path.join(SAIDA, 'fila.json'), null);
  const imoveis = Object.entries(estado).filter(([c]) => /^\d+$/.test(c));
  const pubs = Object.entries(publicados);

  const geradas = imoveis.filter(([, e]) => e.status === 'ok').length;
  const erros = imoveis.filter(([, e]) => e.status === 'erro');
  const jaIA = imoveis.filter(([, e]) => e.status === 'ja-ia').length;
  const total = fila?.total || null;

  // por dia (últimos 7 com atividade)
  const porDia = {};
  for (const [, e] of imoveis) if (e.status === 'ok') (porDia[dia(e.data)] ||= { geradas: 0, publicadas: 0 }).geradas++;
  for (const [, p] of pubs) (porDia[dia(p.data)] ||= { geradas: 0, publicadas: 0 }).publicadas++;
  const dias = Object.keys(porDia).sort().slice(-7).map(d => ({ dia: d, ...porDia[d] }));
  const comGeracao = dias.filter(d => d.geradas > 0);
  const mediaPorDia = comGeracao.length ? Math.round(comGeracao.reduce((s, d) => s + d.geradas, 0) / comGeracao.length) : 0;
  const restantes = total ? Math.max(0, total - geradas - jaIA - pubs.filter(([c]) => !estado[c]).length) : null;

  const condominios = fila ? Object.entries(fila.porCondominio).map(([slug, codigos]) => ({
    slug,
    total: codigos.length,
    geradas: codigos.filter(c => estado[c]?.status === 'ok' || estado[c]?.status === 'ja-ia').length,
    publicadas: codigos.filter(c => publicados[c]).length,
    erros: codigos.filter(c => estado[c]?.status === 'erro').length,
  })) : [];

  const r = {
    total, geradas, publicadas: pubs.length, sitePendente: pubs.filter(([, p]) => !p.site).length,
    erros: erros.length, jaIA, rejeitados: rejeitados().length, restantes,
    aguardandoPublicacao: imoveis.filter(([c, e]) => e.status === 'ok' && !publicados[c]).length,
    mediaPorDia, previsaoDias: restantes && mediaPorDia ? Math.ceil(restantes / mediaPorDia) : null,
    dias, condominios, filaEm: fila?.em || null,
    ultimosErros: erros.sort((a, b) => (b[1].data > a[1].data ? 1 : -1)).slice(0, 8)
      .map(([c, e]) => ({ codigo: c, erro: e.erro, tentativas: e.tentativas, data: e.data })),
  };
  if (desde) {
    r.desde = {
      geradas: imoveis.filter(([, e]) => e.status === 'ok' && e.data >= desde).length,
      publicadas: pubs.filter(([, p]) => p.data >= desde).length,
      erros: erros.filter(([, e]) => e.data >= desde).length,
    };
  }
  return r;
}

module.exports = { resumo };
