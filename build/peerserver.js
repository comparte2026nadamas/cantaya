const { PeerServer } = require('peer');
PeerServer({ port: 9000, host: '127.0.0.1', path: '/' }, () => console.log('peer up'));
