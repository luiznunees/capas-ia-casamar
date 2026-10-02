// Gera a versão 4:5 da foto para o card de destaque do casamarimoveis.net.
// O card mede 352x450 no desktop (proporção ~0,78) e corta a foto pelo centro (object-fit: cover).
//
// Uso:
//   node recortar.js                         -> processa todas as imagens da pasta entrada/
//   node recortar.js <url-do-imovel>         -> baixa a Foto 1 da página do imóvel no site
//   node recortar.js <url-da-imagem>         -> baixa e recorta a imagem
//   node recortar.js foto.jpg                -> recorta um arquivo local
//
// Opções:
//   --pos=centro|atencao|esquerda|direita   onde posicionar o recorte (padrão: centro)
//   --largura=1080                          largura final (padrão: a maior possível sem ampliar, até 1080)
//   --ampliar                               permite ampliar a foto para chegar na largura pedida

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const { ENTRADA, SAIDA, carregar, alvosOuEntrada } = require('./fotos');

const PROPORCAO = 4 / 5;
const LARGURA_MAX = 1080;

const POSICOES = {
  centro: 'centre',
  atencao: sharp.strategy.attention,
  esquerda: 'left',
  direita: 'right',
};

function lerOpcoes(argv) {
  const opcoes = { pos: 'centro', largura: null, ampliar: false, alvos: [] };
  for (const arg of argv) {
    if (arg.startsWith('--pos=')) opcoes.pos = arg.slice(6);
    else if (arg.startsWith('--largura=')) opcoes.largura = parseInt(arg.slice(10), 10);
    else if (arg === '--ampliar') opcoes.ampliar = true;
    else opcoes.alvos.push(arg);
  }
  if (!POSICOES[opcoes.pos]) throw new Error(`--pos inválido: ${opcoes.pos} (use ${Object.keys(POSICOES).join(', ')})`);
  return opcoes;
}

async function recortar({ buffer, nome }, opcoes) {
  const meta = await sharp(buffer).metadata();
  const larguraOrig = meta.autoOrient?.width ?? meta.width;
  const alturaOrig = meta.autoOrient?.height ?? meta.height;

  // Maior área 4:5 que cabe na foto original, sem ampliar.
  const larguraNativa = Math.min(larguraOrig, Math.round(alturaOrig * PROPORCAO));

  let largura = opcoes.largura ?? Math.min(LARGURA_MAX, larguraNativa);
  if (largura > larguraNativa && !opcoes.ampliar) largura = larguraNativa;
  const altura = Math.round(largura / PROPORCAO);

  const destino = path.join(SAIDA, `${nome}_card.jpg`);
  await sharp(buffer)
    .rotate()
    .resize(largura, altura, { fit: 'cover', position: POSICOES[opcoes.pos] })
    .jpeg({ quality: 85, mozjpeg: true, progressive: true })
    .toFile(destino);

  const aviso = largura < 704 ? '  (abaixo de 704x900: pode ficar menos nítido em telas retina)' : '';
  console.log(`${nome}: ${larguraOrig}x${alturaOrig} -> ${largura}x${altura}  ${destino}${aviso}`);
}

async function main() {
  const opcoes = lerOpcoes(process.argv.slice(2));
  fs.mkdirSync(SAIDA, { recursive: true });

  const alvos = alvosOuEntrada(opcoes.alvos);
  if (alvos.length === 0) {
    console.log(`Nenhuma imagem em ${ENTRADA}. Coloque as fotos lá ou passe URLs como argumento.`);
    return;
  }

  let falhas = 0;
  for (const [i, alvo] of alvos.entries()) {
    try {
      await recortar(await carregar(alvo, i), opcoes);
    } catch (erro) {
      falhas++;
      console.error(`ERRO em ${alvo}: ${erro.message}`);
    }
  }
  if (falhas) process.exitCode = 1;
}

main();
