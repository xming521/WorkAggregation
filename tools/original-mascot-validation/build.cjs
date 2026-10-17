const path = require('node:path');
(async () => {
  const web = path.resolve(__dirname, '../../web');
  const { build } = await import(path.join(web, 'node_modules/vite/dist/node/index.js'));
  const react = (await import(path.join(web, 'node_modules/@vitejs/plugin-react/dist/index.js'))).default;
  await build({ configFile: false, root: __dirname, publicDir: path.join(web, 'public'), plugins: [react()],
    resolve: { alias: { '@': path.join(web, 'src'), react: path.join(web, 'node_modules/react'), 'react-dom': path.join(web, 'node_modules/react-dom') } },
    build: { outDir: 'dist', emptyOutDir: true, assetsInlineLimit: 0 } });
})().catch(error => { console.error(error); process.exitCode = 1; });
