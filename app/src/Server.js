'use strict';

const express = require('express');
const cors = require('cors');
const compression = require('compression');
const https = require('httpolyglot');
const mediasoup = require('mediasoup');
const mediasoupClient = require('mediasoup-client');
const config = require('./config');
const path = require('path');
const ngrok = require('ngrok');
const fs = require('fs');
const Host = require('./Host');
const Room = require('./Room');
const Peer = require('./Peer');
const ServerApi = require('./ServerApi');
const Logger = require('./Logger');
const log = new Logger('Server');
const yamlJS = require('yamljs');
const swaggerUi = require('swagger-ui-express');
const swaggerDocument = yamlJS.load(path.join(__dirname + '/../api/swagger.yaml'));
const Sentry = require('@sentry/node');
const { CaptureConsole } = require('@sentry/integrations');

const app = express();

const options = {
    key: fs.readFileSync(path.join(__dirname, config.sslKey), 'utf-8'),
    cert: fs.readFileSync(path.join(__dirname, config.sslCrt), 'utf-8'),
};

const httpsServer = https.createServer(options, app);
const io = require('socket.io')(httpsServer, {
    maxHttpBufferSize: 1e7,
});
const host = 'https://' + 'localhost' + ':' + config.listenPort; // config.listenIp
const announcedIP = config.mediasoup.webRtcTransport.listenIps[0].announcedIp;

const hostCfg = {
    protected: config.hostProtected,
    username: config.hostUsername,
    password: config.hostPassword,
    authenticated: !config.hostProtected,
};

const apiBasePath = '/api/v1'; // api endpoint path
const api_docs = host + apiBasePath + '/docs'; // api docs

// Sentry monitoring
const sentryEnabled = config.sentry.enabled;
const sentryDSN = config.sentry.DSN;
const sentryTracesSampleRate = config.sentry.tracesSampleRate;
if (sentryEnabled) {
    Sentry.init({
        dsn: sentryDSN,
        integrations: [
            new CaptureConsole({
                // ['log', 'info', 'warn', 'error', 'debug', 'assert']
                levels: ['warn', 'error'],
            }),
        ],
        tracesSampleRate: sentryTracesSampleRate,
    });
    /*
    log.log('test-log');
    log.info('test-info');
    log.warn('test-warning');
    log.warn('test-error');
    log.warn('test-debug');
    */
}

// Authenticated IP by Login
let authHost;

// all mediasoup workers
let workers = [];
let nextMediasoupWorkerIdx = 0;

// all Room lists
let roomList = new Map();

// directory
const dir = {
    public: path.join(__dirname, '../../', 'public'),
};

// html views
const view = {
    about: path.join(__dirname, '../../', 'public/view/about.html'),
    landing: path.join(__dirname, '../../', 'public/view/landing.html'),
    login: path.join(__dirname, '../../', 'public/view/login.html'),
    newRoom: path.join(__dirname, '../../', 'public/view/newroom.html'),
    notFound: path.join(__dirname, '../../', 'public/view/404.html'),
    permission: path.join(__dirname, '../../', 'public/view/permission.html'),
    privacy: path.join(__dirname, '../../', 'public/view/privacy.html'),
    room: path.join(__dirname, '../../', 'public/view/Room.html'),
};

app.use(cors());
app.use(compression());
app.use(express.json());
app.use(express.static(dir.public));
app.use(apiBasePath + '/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument)); // api docs

// Remove trailing slashes in url handle bad requests
app.use((err, req, res, next) => {
    if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
        log.debug('Request Error', {
            header: req.headers,
            body: req.body,
            error: err.message,
        });
        return res.status(400).send({ status: 404, message: err.message }); // Bad request
    }
    if (req.path.substr(-1) === '/' && req.path.length > 1) {
        let query = req.url.slice(req.path.length);
        res.redirect(301, req.path.slice(0, -1) + query);
    } else {
        next();
    }
});

// all start from here
app.get(['/'], (req, res) => {
    if (hostCfg.protected == true) {
        hostCfg.authenticated = false;
        res.sendFile(view.login);
    } else {
        res.sendFile(view.landing);
    }
});

// handle login on host protected
app.get(['/login'], (req, res) => {
    if (hostCfg.protected == true) {
        let ip = getIP(req);
        log.debug(`Request login to host from: ${ip}`, req.query);
        if (req.query.username == hostCfg.username && req.query.password == hostCfg.password) {
            hostCfg.authenticated = true;
            authHost = new Host(ip, true);
            log.debug('LOGIN OK', { ip: ip, authorized: authHost.isAuthorized(ip) });
            res.sendFile(view.landing);
        } else {
            log.debug('LOGIN KO', { ip: ip, authorized: false });
            hostCfg.authenticated = false;
            res.sendFile(view.login);
        }
    } else {
        res.redirect('/');
    }
});

// set new room name and join
app.get(['/newroom'], (req, res) => {
    if (hostCfg.protected == true) {
        let ip = getIP(req);
        if (allowedIP(ip)) {
            res.sendFile(view.newRoom);
        } else {
            hostCfg.authenticated = false;
            res.sendFile(view.login);
        }
    } else {
        res.sendFile(view.newRoom);
    }
});

// no room name specified to join || direct join
app.get('/join/', (req, res) => {
    if (hostCfg.authenticated && Object.keys(req.query).length > 0) {
        log.debug('Direct Join', req.query);
        // http://localhost:3010/join?room=test&name=mirotalksfu&audio=1&video=1&notify=1
        let roomName = req.query.room;
        let peerName = req.query.name;
        let peerAudio = req.query.audio;
        let peerVideo = req.query.video;
        let notify = req.query.notify;
        if (roomName && peerName && peerAudio && peerVideo && notify) {
            return res.sendFile(view.room);
        }
    }
    res.redirect('/');
});

// join room
app.get('/join/*', (req, res) => {
    if (hostCfg.authenticated) {
        res.sendFile(view.room);
    } else {
        res.redirect('/');
    }
});

// if not allow video/audio
app.get(['/permission'], (req, res) => {
    res.sendFile(view.permission);
});

// privacy policy
app.get(['/privacy'], (req, res) => {
    res.sendFile(view.privacy);
});

// mirotalk about
app.get(['/about'], (req, res) => {
    res.sendFile(view.about);
});

// ####################################################
// API
// ####################################################

// request meeting room endpoint
app.post(['/api/v1/meeting'], (req, res) => {
    // check if user was authorized for the api call
    let host = req.headers.host;
    let authorization = req.headers.authorization;
    let api = new ServerApi(host, authorization);
    if (!api.isAuthorized()) {
        log.debug('MiroTalk get meeting - Unauthorized', {
            header: req.headers,
            body: req.body,
        });
        return res.status(403).json({ error: 'Unauthorized!' });
    }
    // setup meeting URL
    let meetingURL = api.getMeetingURL();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ meeting: meetingURL }));
    // log.debug the output if all done
    log.debug('MiroTalk get meeting - Authorized', {
        header: req.headers,
        body: req.body,
        meeting: meetingURL,
    });
});

// request join room endpoint
app.post(['/api/v1/join'], (req, res) => {
    // check if user was authorized for the api call
    let host = req.headers.host;
    let authorization = req.headers.authorization;
    let api = new ServerApi(host, authorization);
    if (!api.isAuthorized()) {
        log.debug('MiroTalk get join - Unauthorized', {
            header: req.headers,
            body: req.body,
        });
        return res.status(403).json({ error: 'Unauthorized!' });
    }
    // setup Join URL
    let joinURL = api.getJoinURL(req.body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ join: joinURL }));
    // log.debug the output if all done
    log.debug('MiroTalk get join - Authorized', {
        header: req.headers,
        body: req.body,
        join: joinURL,
    });
});

// not match any of page before, so 404 not found
app.get('*', function (req, res) {
    res.sendFile(view.notFound);
});

// ####################################################
// NGROK
// ####################################################

async function ngrokStart() {
    try {
        await ngrok.authtoken(config.ngrokAuthToken);
        await ngrok.connect(config.listenPort);
        let api = ngrok.getApi();
        let data = await api.listTunnels();
        let pu0 = data.tunnels[0].public_url;
        let pu1 = data.tunnels[1].public_url;
        let tunnel = pu0.startsWith('https') ? pu0 : pu1;
        log.debug('Listening on', {
            hostConfig: hostCfg,
            announced_ip: announcedIP,
            server: host,
            tunnel: tunnel,
            api_docs: api_docs,
            mediasoup_server_version: mediasoup.version,
            mediasoup_client_version: mediasoupClient.version,
            sentry_enabled: sentryEnabled,
        });
    } catch (err) {
        log.error('Ngrok Start error: ', err);
        process.exit(1);
    }
}

// ####################################################
// START SERVER
// ####################################################

httpsServer.listen(config.listenPort, () => {
    log.debug(
        `%c

	███████╗██╗ ██████╗ ███╗   ██╗      ███████╗███████╗██████╗ ██╗   ██╗███████╗██████╗ 
	██╔════╝██║██╔════╝ ████╗  ██║      ██╔════╝██╔════╝██╔══██╗██║   ██║██╔════╝██╔══██╗
	███████╗██║██║  ███╗██╔██╗ ██║█████╗███████╗█████╗  ██████╔╝██║   ██║█████╗  ██████╔╝
	╚════██║██║██║   ██║██║╚██╗██║╚════╝╚════██║██╔══╝  ██╔══██╗╚██╗ ██╔╝██╔══╝  ██╔══██╗
	███████║██║╚██████╔╝██║ ╚████║      ███████║███████╗██║  ██║ ╚████╔╝ ███████╗██║  ██║
	╚══════╝╚═╝ ╚═════╝ ╚═╝  ╚═══╝      ╚══════╝╚══════╝╚═╝  ╚═╝  ╚═══╝  ╚══════╝╚═╝  ╚═╝ started...

	`,
        'font-family:monospace',
    );

    if (config.ngrokAuthToken !== '') {
        ngrokStart();
        return;
    }
    log.debug('Listening on', {
        hostConfig: hostCfg,
        announced_ip: announcedIP,
        server: host,
        api_docs: api_docs,
        mediasoup_server_version: mediasoup.version,
        mediasoup_client_version: mediasoupClient.version,
        sentry_enabled: sentryEnabled,
    });
});

// ####################################################
// WORKERS
// ####################################################

(async () => {
    await createWorkers();
})();

async function createWorkers() {
    let { numWorkers } = config.mediasoup;

    log.debug('WORKERS:', numWorkers);

    for (let i = 0; i < numWorkers; i++) {
        let worker = await mediasoup.createWorker({
            logLevel: config.mediasoup.worker.logLevel,
            logTags: config.mediasoup.worker.logTags,
            rtcMinPort: config.mediasoup.worker.rtcMinPort,
            rtcMaxPort: config.mediasoup.worker.rtcMaxPort,
        });
        worker.on('died', () => {
            log.error('Mediasoup worker died, exiting in 2 seconds... [pid:%d]', worker.pid);
            setTimeout(() => process.exit(1), 2000);
        });
        workers.push(worker);
    }
}

async function getMediasoupWorker() {
    const worker = workers[nextMediasoupWorkerIdx];
    if (++nextMediasoupWorkerIdx === workers.length) nextMediasoupWorkerIdx = 0;
    return worker;
}

// ####################################################
// SOCKET IO
// ####################################################

io.on('connection', (socket) => {
    socket.on('createRoom', async ({ room_id }, callback) => {
        socket.room_id = room_id;

        if (roomList.has(socket.room_id)) {
            callback('already exists');
        } else {
            log.debug('Created room', { room_id: socket.room_id });
            let worker = await getMediasoupWorker();
            roomList.set(socket.room_id, new Room(socket.room_id, worker, io));
            callback(socket.room_id);
        }
    });

    socket.on('roomAction', (data) => {
        log.debug('Room action:', data);
        switch (data.action) {
            case 'lock':
                roomList.get(socket.room_id).setLocked(true, data.password);
                roomList.get(socket.room_id).broadCast(socket.id, 'roomAction', data.action);
                break;
            case 'checkPassword':
                let roomData = {
                    room: null,
                    password: 'KO',
                };
                if (data.password == roomList.get(socket.room_id).getPassword()) {
                    roomData.room = roomList.get(socket.room_id).toJson();
                    roomData.password = 'OK';
                    roomList.get(socket.room_id).sendTo(socket.id, 'roomPassword', roomData);
                } else {
                    roomList.get(socket.room_id).sendTo(socket.id, 'roomPassword', roomData);
                }
                break;
            case 'unlock':
                roomList.get(socket.room_id).setLocked(false);
                roomList.get(socket.room_id).broadCast(socket.id, 'roomAction', data.action);
                break;
        }
        log.debug('Room locked:', roomList.get(socket.room_id).isLocked());
    });

    socket.on('peerAction', (data) => {
        log.debug('Peer action:', data);
        if (data.broadcast) {
            roomList.get(socket.room_id).broadCast(data.peer_id, 'peerAction', data);
        } else {
            roomList.get(socket.room_id).sendTo(data.peer_id, 'peerAction', data);
        }
    });

    socket.on('updatePeerInfo', (data) => {
        log.debug('Peer info update:', data);
        // peer_info hand raise Or lower
        roomList.get(socket.room_id).getPeers().get(socket.id).updatePeerInfo(data);
        roomList.get(socket.room_id).broadCast(socket.id, 'updatePeerInfo', data);
    });

    socket.on('fileInfo', (data) => {
        log.debug('Send File Info', data);
        if (data.broadcast) {
            roomList.get(socket.room_id).broadCast(socket.id, 'fileInfo', data);
        } else {
            roomList.get(socket.room_id).sendTo(data.peer_id, 'fileInfo', data);
        }
    });

    socket.on('file', (data) => {
        if (data.broadcast) {
            roomList.get(socket.room_id).broadCast(socket.id, 'file', data);
        } else {
            roomList.get(socket.room_id).sendTo(data.peer_id, 'file', data);
        }
    });

    socket.on('fileAbort', (data) => {
        roomList.get(socket.room_id).broadCast(socket.id, 'fileAbort', data);
    });

    socket.on('youTubeAction', (data) => {
        log.debug('YouTube: ', data);
        roomList.get(socket.room_id).broadCast(socket.id, 'youTubeAction', data);
    });

    socket.on('wbCanvasToJson', (data) => {
        // let objLength = bytesToSize(Object.keys(data).length);
        // log.debug('Send Whiteboard canvas JSON', { length: objLength });
        roomList.get(socket.room_id).broadCast(socket.id, 'wbCanvasToJson', data);
    });

    socket.on('whiteboardAction', (data) => {
        log.debug('Whiteboard', data);
        roomList.get(socket.room_id).broadCast(socket.id, 'whiteboardAction', data);
    });

    socket.on('setVideoOff', (data) => {
        log.debug('Video off', getPeerName());
        roomList.get(socket.room_id).broadCast(socket.id, 'setVideoOff', data);
    });

    socket.on('join', (data, cb) => {
        if (!roomList.has(socket.room_id)) {
            return cb({
                error: 'Room does not exist',
            });
        }

        log.debug('User joined', data);
        roomList.get(socket.room_id).addPeer(new Peer(socket.id, data));

        if (roomList.get(socket.room_id).isLocked()) {
            log.debug('User rejected because room is locked');
            cb('isLocked');
            return;
        }

        cb(roomList.get(socket.room_id).toJson());
    });

    socket.on('getRouterRtpCapabilities', (_, callback) => {
        log.debug('Get RouterRtpCapabilities', getPeerName());
        try {
            callback(roomList.get(socket.room_id).getRtpCapabilities());
        } catch (err) {
            callback({
                error: err.message,
            });
        }
    });

    socket.on('getProducers', () => {
        if (!roomList.has(socket.room_id)) return;

        log.debug('Get producers', getPeerName());

        // send all the current producer to newly joined member
        let producerList = roomList.get(socket.room_id).getProducerListForPeer();

        socket.emit('newProducers', producerList);
    });

    socket.on('createWebRtcTransport', async (_, callback) => {
        log.debug('Create webrtc transport', getPeerName());
        try {
            const { params } = await roomList.get(socket.room_id).createWebRtcTransport(socket.id);
            callback(params);
        } catch (err) {
            log.error('Create WebRtc Transport error: ', err.message);
            callback({
                error: err.message,
            });
        }
    });

    socket.on('connectTransport', async ({ transport_id, dtlsParameters }, callback) => {
        if (!roomList.has(socket.room_id)) return;
        log.debug('Connect transport', getPeerName());

        await roomList.get(socket.room_id).connectPeerTransport(socket.id, transport_id, dtlsParameters);

        callback('success');
    });

    socket.on('produce', async ({ kind, rtpParameters, producerTransportId }, callback) => {
        if (!roomList.has(socket.room_id)) {
            return callback({ error: 'Room not found' });
        }

        let peer_name = getPeerName(false);

        let producer_id = await roomList
            .get(socket.room_id)
            .produce(socket.id, producerTransportId, rtpParameters, kind);

        log.debug('Produce', {
            kind: kind,
            peer_name: peer_name,
            peer_id: socket.id,
            producer_id: producer_id,
        });

        // add & monitor producer audio level
        if (kind === 'audio') {
            roomList.get(socket.room_id).addProducerToAudioLevelObserver({ producerId: producer_id });
        }

        // peer_info audio Or video ON
        let data = {
            peer_name: peer_name,
            type: kind,
            status: true,
        };
        roomList.get(socket.room_id).getPeers().get(socket.id).updatePeerInfo(data);

        callback({
            producer_id,
        });
    });

    socket.on('consume', async ({ consumerTransportId, producerId, rtpCapabilities }, callback) => {
        if (!roomList.has(socket.room_id)) {
            return callback({ error: 'Room not found' });
        }

        let params = await roomList
            .get(socket.room_id)
            .consume(socket.id, consumerTransportId, producerId, rtpCapabilities);

        log.debug('Consuming', {
            peer_name: getPeerName(false),
            producer_id: producerId,
            consumer_id: params.id,
        });

        callback(params);
    });

    socket.on('producerClosed', (data) => {
        log.debug('Producer close', data);

        // peer_info audio Or video OFF
        roomList.get(socket.room_id).getPeers().get(socket.id).updatePeerInfo(data);
        roomList.get(socket.room_id).closeProducer(socket.id, data.producer_id);
    });

    socket.on('resume', async (_, callback) => {
        await consumer.resume();
        callback();
    });

    socket.on('getRoomInfo', (_, cb) => {
        log.debug('Send Room Info');
        cb(roomList.get(socket.room_id).toJson());
    });

    socket.on('refreshParticipantsCount', () => {
        let data = {
            room_id: socket.room_id,
            peer_counts: roomList.get(socket.room_id).getPeers().size,
        };
        log.debug('Refresh Participants count', data);
        roomList.get(socket.room_id).broadCast(socket.id, 'refreshParticipantsCount', data);
    });

    socket.on('message', (data) => {
        log.debug('message', data);
        if (data.to_peer_id == 'all') {
            roomList.get(socket.room_id).broadCast(socket.id, 'message', data);
        } else {
            roomList.get(socket.room_id).sendTo(data.to_peer_id, 'message', data);
        }
    });

    socket.on('disconnect', () => {
        if (!socket.room_id) return;

        log.debug('Disconnect', getPeerName());

        roomList.get(socket.room_id).removePeer(socket.id);

        if (roomList.get(socket.room_id).getPeers().size === 0 && roomList.get(socket.room_id).isLocked()) {
            roomList.get(socket.room_id).setLocked(false);
        }

        roomList.get(socket.room_id).broadCast(socket.id, 'removeMe', removeMeData());

        removeIP(socket);
    });

    socket.on('exitRoom', async (_, callback) => {
        if (!roomList.has(socket.room_id)) {
            callback({
                error: 'Not currently in a room',
            });
            return;
        }
        log.debug('Exit room', getPeerName());

        // close transports
        await roomList.get(socket.room_id).removePeer(socket.id);

        roomList.get(socket.room_id).broadCast(socket.id, 'removeMe', removeMeData());

        if (roomList.get(socket.room_id).getPeers().size === 0) {
            roomList.delete(socket.room_id);
        }

        socket.room_id = null;

        removeIP(socket);

        callback('Successfully exited room');
    });

    // common
    function getPeerName(json = true) {
        if (json) {
            return {
                peer_name:
                    roomList.get(socket.room_id) &&
                    roomList.get(socket.room_id).getPeers().get(socket.id).peer_info.peer_name,
            };
        }
        return (
            roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().get(socket.id).peer_info.peer_name
        );
    }

    function removeMeData() {
        return {
            room_id: roomList.get(socket.room_id) && socket.room_id,
            peer_id: socket.id,
            peer_counts: roomList.get(socket.room_id) && roomList.get(socket.room_id).getPeers().size,
        };
    }

    function bytesToSize(bytes) {
        let sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        if (bytes == 0) return '0 Byte';
        let i = parseInt(Math.floor(Math.log(bytes) / Math.log(1024)));
        return Math.round(bytes / Math.pow(1024, i), 2) + ' ' + sizes[i];
    }
});

function getIP(req) {
    return req.headers['x-forwarded-for'] || req.socket.remoteAddress;
}
function allowedIP(ip) {
    return authHost != null && authHost.isAuthorized(ip);
}
function removeIP(socket) {
    if (hostCfg.protected == true) {
        let ip = socket.handshake.address;
        if (ip && allowedIP(ip)) {
            authHost.deleteIP(ip);
            hostCfg.authenticated = false;
            log.debug('Remove IP from auth', { ip: ip });
        }
    }
}
