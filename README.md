# Tinteiro

Escrita e desenho à mão nas notas do Obsidian, com motor de tinta próprio em WebGL2. Compatível
com o plugin [Ink](https://github.com/daledesilva/obsidian_ink): lê e grava os mesmos arquivos `.svg` e os mesmos embeds
(`![InkWriting](<…>)`, `![InkDrawing](<…>)` com o link `[Edit …]`), então as notas existentes abrem
sem conversão e o plugin antigo continua lendo os arquivos novos.

## Por que é fluido

- **Nada do editor da nota é tocado enquanto se escreve.** Cada embed vive num Shadow DOM, e a
  barra de ferramentas numa camada própria do painel, fora do conteúdo da nota. O
  `MutationObserver` do CodeMirror, que no Ink custava 100 a 400 ms por toque, não vê nada.
- **Tinta na GPU.** Um traço é uma cadeia de cápsulas de raio variável (o envelope exato de uma
  ponta redonda com pressão), sobre uma Catmull-Rom centrípeta que passa por cada amostra da
  caneta. Cada cápsula é uma instância cujo shader avalia o campo de distância, com borda suavizada
  analiticamente e nítida em qualquer zoom. Um contexto WebGL2 só, compartilhado, pinta a página
  inteira em uma fração de milissegundo e entrega o resultado a cada embed como `ImageBitmap`.
- **Ocioso é ocioso.** Nenhum polling. Embeds travados pintam uma vez e soltam a memória quando
  saem de perto da tela.
- **Salvar não pesa.** Cada traço guarda seu JSON e seu contorno SVG prontos; gravar é concatenar.
  Os arquivos saem cerca de 40 % menores (coordenadas com 0,01 unidade de página).

Medido no Obsidian 1.14.4 (Electron 43, Iris Xe), no maior desenho da vault (871 traços), com o
Live Preview ativo: escrever, apagar, arrastar e dar zoom ficam com p99 de 16,8 ms por quadro e
nenhuma tarefa longa; destravar e travar não geram quadro longo.

## Funções

Escrita (página de 2000 unidades, pautas pela altura de linha, linhas livres abaixo) e desenho
(câmera com zoom 0,1 a 5×, enquadramento salvo no link, redimensionar centralizado). Canetas
tinteiro, esferográfica, lápis e marca-texto; cor por traço com paleta, recentes e HSL; borracha
que corta o traço ou apaga o traço inteiro; laço com mover, apagar, duplicar, copiar e recolorir;
oito figuras; imagens coladas com redimensionamento; papel em branco, pautado, quadriculado,
pontilhado e isométrico; folha clara ou escura gravada no arquivo; curva de pressão editável;
desfazer e refazer pelo teclado, por 2 e 3 dedos e pela barra; Ctrl segurado como borracha; dedo
rola a nota e dois dedos movem e ampliam o desenho; tela cheia; edição também no modo leitura;
arquivos pré-0.5 (`.writing`, `.drawing`) abertos somente leitura, com cópia editável.

## Desenvolvimento

```sh
npm install
npm test          # vitest: formato (ida e volta nos arquivos da vault), geometria
npm run build     # dist/main.js, dist/styles.css, dist/manifest.json
```

Instalar: copiar `dist/*` para `<vault>/.obsidian/plugins/tinteiro/` e ativar em Plugins da comunidade.
O Ink e o Tinteiro tratam os mesmos embeds, então não devem ficar ligados ao mesmo tempo.

## Licença e origem

MIT. O código é próprio; do Ink vêm só o formato dos arquivos e dos embeds, mantidos para
compatibilidade. Usa [perfect-freehand](https://github.com/steveruizok/perfect-freehand) (MIT)
para suavizar e pesar os pontos da caneta.

`bench/` tem as bancadas de medição: `main.cjs` (motor isolado em Electron fora da tela) e
`cdp.mjs` (roteiros que dirigem uma instância isolada do Obsidian pela porta de depuração).
