/* eslint-disable import/no-unresolved */
/* eslint-disable global-require */
const express = require("express");
const next = require("next");
const url = require("url");
const path = require("path");
const WebSocket = require("ws");
const map = require("lib0/dist/map.cjs");
const { PubSub } = require("flok-core");
const process = require("process");
const configureSsl = require("./configureSsl");
const sslRedirect = require("./sslRedirect");
const mediasoup = require('mediasoup');

const wsReadyStateConnecting = 0;
const wsReadyStateOpen = 1;
const wsReadyStateClosing = 2; // eslint-disable-line
const wsReadyStateClosed = 3; // eslint-disable-line

const pingTimeout = 30000;

/**
 * @param {any} conn
 * @param {object} message
 */
const send = (conn, message) => {
  if (
    conn.readyState !== wsReadyStateConnecting &&
    conn.readyState !== wsReadyStateOpen
  ) {
    conn.close();
  }
  try {
    conn.send(JSON.stringify(message));
  } catch (e) {
    conn.close();
  }
};


class Server {
  constructor(ctx) {
    const { host, port, isDevelopment, redirectHttps } = ctx;

    this.host = host || "0.0.0.0";
    this.port = port || 3000;
    this.isDevelopment = isDevelopment || false;
    this.redirectHttps = redirectHttps || false;

    this.started = false;
    this._topics = new Map();
    this._mediasoupRouter
    // todo: allow multiple producers
    this._producerId = null
  }

  start() {
    if (this.started) return this;

    const nextApp = next({
      dev: this.isDevelopment,
      dir: path.join(__dirname, "..")
    });
    const handle = nextApp.getRequestHandler();

    function addClient(uuid) {
      console.log("[pubsub] Add client", uuid);
    }

    function removeClient(uuid) {
      console.log("[pubsub] Remove client", uuid);
    }

    nextApp.prepare().then(() => {
      const app = express();
      const wss = new WebSocket.Server({ noServer: true });
      const pubsubWss = new WebSocket.Server({ noServer: true });
      const msWss = new WebSocket.Server({ noServer: true });
      //const server = http.createServer(app);
      const server = configureSsl(app);
      
      (async () => {
        try {
          const mediaCodecs = [
                  {
                    kind: 'audio',
                    mimeType: 'audio/opus',
                    clockRate: 48000,
                    channels: 2
                  },
                ]
          const worker = await mediasoup.createWorker()
          this._mediasoupRouter = await worker.createRouter({ mediaCodecs });
        } catch (err) {
          console.error(err);
        }
      })();

      server.on("upgrade", (request, socket, head) => {
        const { pathname } = url.parse(request.url);

        if (pathname === "/signal") {
          wss.handleUpgrade(request, socket, head, ws => {
            wss.emit("connection", ws);
          });
        } else if (pathname === "/pubsub") {
          pubsubWss.handleUpgrade(request, socket, head, ws => {
            pubsubWss.emit("connection", ws);
          });
        } else if (pathname === "/ms") {
          msWss.handleUpgrade(request, socket, head, ws => {
            msWss.emit("connection", ws);
          });
        } else {
          socket.destroy();
        }
      });

      wss.on("connection", conn => this.onSignalingServerConnection(conn));
      msWss.on("connection", conn => this.onMediasoupServerConnection(conn));

      // Prepare PubSub WebScoket server (pubsub)
      const pubSubServer = new PubSub({
        wss: pubsubWss,
        onConnection: addClient,
        onDisconnection: removeClient
      });
      // eslint-disable-next-line no-param-reassign
      app.pubsub = pubSubServer;

      if (this.redirectHttps) {
        console.log("> Going to redirect http to https");
        app.use(
          sslRedirect({
            port: process.env.NODE_ENV === "production" ? null : this.port
          })
        );
      }

      // Let Next to handle everything else
      app.get("*", (req, res) => {
        return handle(req, res);
      });

      server.listen(this.port, this.host, err => {
        if (err) throw err;
        console.log(`> Listening on http://${this.host}:${this.port}`);
      });
    });

    return this;
  }

  onSignalingServerConnection(conn) {
    /**
     * @type {Set<string>}
     */


    const subscribedTopics = new Set();
    let closed = false;
    // Check if connection is still alive
    let pongReceived = true;
    const pingInterval = setInterval(() => {
      if (!pongReceived) {
        conn.close();
        clearInterval(pingInterval);
      } else {
        pongReceived = false;
        try {
          conn.ping();
        } catch (e) {
          conn.close();
        }
      }
    }, pingTimeout);

    conn.on("pong", () => {
      pongReceived = true;
    });

    conn.on("close", () => {
      subscribedTopics.forEach(topicName => {
        const subs = this._topics.get(topicName) || new Set();
        subs.delete(conn);
        if (subs.size === 0) {
          this._topics.delete(topicName);
        }
      });
      subscribedTopics.clear();
      closed = true;
    });

    conn.on(
      "message",
      /** @param {object} message */ message => {
        if (typeof message === "string") {
          // eslint-disable-next-line no-param-reassign
          message = JSON.parse(message);
        }
        if (message && message.type && !closed) {
          switch (message.type) {
            case "subscribe":
              /** @type {Array<string>} */ (message.topics || []).forEach(
                topicName => {
                  if (typeof topicName === "string") {
                    // add conn to topic
                    const topic = map.setIfUndefined(
                      this._topics,
                      topicName,
                      () => new Set()
                    );
                    topic.add(conn);
                    // add topic to conn
                    subscribedTopics.add(topicName);
                  }
                }
              );
              break;
            case "unsubscribe":
              /** @type {Array<string>} */ (message.topics || []).forEach(
                topicName => {
                  const subs = this._topics.get(topicName);
                  if (subs) {
                    subs.delete(conn);
                  }
                }
              );
              break;
            case "publish":
              if (message.topic) {
                const receivers = this._topics.get(message.topic);
                if (receivers) {
                  receivers.forEach(receiver => send(receiver, message));
                }
              }
              break;
            case "ping":
              send(conn, { type: "pong" });
              break;
            default:
          }
        }
      }
    );
  }

  onMediasoupServerConnection(conn) {
    //TODO: lots and lots of error handling!!
    console.log('new media soup ws connection', this._producerId)

    let closed = false
    let producerTransport
    let consumerTransport

    conn.on("close", () => {
      closed = true
      this._producerId = null
    });


    const handleMessage = async (message) => {
      if (typeof message === "string") {
        // eslint-disable-next-line no-param-reassign
        message = JSON.parse(message)
      }
      if (message && message.type && !closed) {
        switch (message.type) {
          case "rtp_capabilities_request":
            const routerRtpCapabilities = this._mediasoupRouter.rtpCapabilities
            const data = {routerRtpCapabilities, producerId: this._producerId}
            // since this is called first, provide producerId if any
            send(conn, {type: 'rtp_capabilities_response', data})
            break;
          case "create_producer_transport_request":
            try {
              const { transport, data } = await createWebRtcTransport()
              producerTransport = transport
              send(conn, {type: 'create_producer_transport_response', data})
            } catch (err) {
              console.error(err);
            }
            break;
          case "create_consumer_transport_request":
            try {
              const { transport, data } = await createWebRtcTransport();
              consumerTransport = transport
              send(conn, {type: 'create_consumer_transport_response', data})
            } catch (err) {
              console.error(err);
            }
            break;
          case "connect_producer_transport_request":
            await producerTransport.connect({ dtlsParameters: message.data.dtlsParameters })
            send(conn, {type: 'connect_producer_transport_response', data: true})
            break;
          case "connect_consumer_transport_request":
            await consumerTransport.connect({ dtlsParameters: message.data.dtlsParameters })
            send(conn, {type: 'connect_consumer_transport_response', data: true})
            break;
          case "produce_request":
            const {kind, rtpParameters} = message.data
            const producer = await producerTransport.produce({ kind, rtpParameters })
            this._producerId = producer.id
            send(conn, {type: 'produce_response', data: {id: producer.id}})
            break;
          case "consume_request":
            const {rtpCapabilities} = message.data
            const consumer = await consumerTransport.consume({
                producerId: this._producerId,
                rtpCapabilities,
              })

            send(conn, {type: 'consume_response', data: {
                producerId: this._producerId,
                id: consumer.id,
                kind: consumer.kind,
                rtpParameters: consumer.rtpParameters,
                type: consumer.type,
              }
            })
            break;
          case "ping":
            send(conn, {type: 'pong'})
            break;
          default:
            console.error('unhandled message ',message)
        }
      }
    }

    conn.on( "message", handleMessage)
    
    const createWebRtcTransport = async () => {
      const listenIps = [
        {
          ip: '127.0.0.1',
          announcedIp: null,
        }
      ]

      const transport = await this._mediasoupRouter.createWebRtcTransport({
        listenIps,
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
      });

      return {
        transport,
        data: {
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        }
      };
    }

  }

}

module.exports = Server;
