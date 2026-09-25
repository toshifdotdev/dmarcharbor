import { createApp } from './app.js';

const port = Number(process.env.PORT ?? 4000);

if (process.env.NODE_ENV !== 'test') {
  createApp().listen(port, () => {
    console.log(`DMARC Harbor API listening on port ${port}`);
  });
}
