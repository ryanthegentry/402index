import helmet from 'helmet';
import http from 'http';
import express from 'express';

const app = express();
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://plausible.io"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "https://plausible.io"],
      fontSrc: ["'self'", "https://plausible.io"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    }
  }
}));
app.get('/', (req, res) => res.send('ok'));

const server = app.listen(0, () => {
  const port = server.address().port;
  http.get('http://localhost:' + port, (res) => {
    console.log('CSP header:', res.headers['content-security-policy']);
    server.close();
  });
});
