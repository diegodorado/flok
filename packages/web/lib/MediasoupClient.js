import * as ws from "lib0/websocket";
import { Device } from 'mediasoup-client';

const RPC_TIMEOUT = 10000

class MediasoupClient extends ws.WebsocketClient {
   
  constructor(mediasoupServerUrl){
    super(mediasoupServerUrl);
    this.queue = new Map()

    // just in case...
    this.onGotProducerId = () => {}
    this.isProducer = false
    
    try {
      // Create a device (use browser auto-detection).
      this.device = new Device();
      this.on("connect",  this.onConnect)
      this.on("message", this.onMessage)
    } catch (error) {
      if (error.name === 'UnsupportedError') {
        console.error('browser not supported')
      }
    }
  }
  
  makeRPC = async (key,data) => {
    this.send({ type: `${key}_request`, data })
    return new Promise( (resolve, reject) =>{
      setTimeout(() => reject('timeout'),RPC_TIMEOUT)
      this.queue.set(key, {resolve, reject})
    })
  }

  onConnect = async () => {
    if(!this.device.loaded){
      const {routerRtpCapabilities,producerId} = await this.makeRPC("rtp_capabilities", {})
      if(producerId)
        this.onGotProducerId(producerId)
      await this.device.load({ routerRtpCapabilities })
    }
  }

  onMessage = async (message) => {

    if(message.type.endsWith("_response")){
      const key = message.type.replace("_response","")
      if(this.queue.has(key)){
        this.queue.get(key).resolve(message.data)
        this.queue.delete(key)
      }else{
        console.error(`${key} response received, but not in queue`)
      }
    }
    else{
      // non RPC messages
      switch (message.type) {
        case "pong":
          break;
        default:
          console.error('unhandled message ',message)
      }

    }

  }

  createProducer = async () => {
    const constraints = {audio: true};
    const stream = await navigator.mediaDevices.getUserMedia(constraints)
    const transportParams = await this.makeRPC("create_producer_transport", {})
    const transport = this.device.createSendTransport(transportParams)

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.makeRPC("connect_producer_transport", {dtlsParameters })
        callback()
      } catch (err) {
        errback(err)
      }
    })
    
    transport.on('produce', async ({ kind, rtpParameters }, callback, errback) => {
      try {
        const { id } = await this.makeRPC("produce", {
          transportId: transport.id,
          kind,
          rtpParameters,
        })
        callback({ id })
      } catch (err) {
        errback(err)
      }
    })

    transport.on('connectionstatechange', (state) => {
      switch (state) {
        case 'connecting':
          console.log( 'publishing...')
          break;
        case 'connected':
          //  document.querySelector('#local_video').srcObject = stream;
          console.log( 'published')
          break;
        case 'failed':
          transport.close();
          this.isProducer = false
          console.log('failed')
          break;
        default: 
          break;
      }
    })
      
    const track = stream.getAudioTracks()[0]
    const params = { track };
    const producer = await transport.produce(params)
    this.isProducer = true
    return producer
  }

  consumeStream = async () => {
    const transportParams = await this.makeRPC("create_consumer_transport", {forceTcp: false})
    const transport = this.device.createRecvTransport(transportParams)

    transport.on('connect', async ({ dtlsParameters }, callback, errback) => {
      try {
        await this.makeRPC("connect_consumer_transport", {transportId: transport.id, dtlsParameters })
        callback()
      } catch (err) {
        errback(err)
      }
    })
    
    transport.on('connectionstatechange', (state) => {
      console.log(state)
      switch (state) {
        case 'connecting':
          console.log( 'publishing...')
          break;
        case 'connected':
          //  document.querySelector('#local_video').srcObject = stream;
          console.log( 'published')
          break;
        case 'failed':
          transport.close();
          console.log('failed')
          break;
        default: 
          break;
      }
    })

    const { rtpCapabilities } = this.device
    const {
      producerId,
      id,
      kind,
      rtpParameters,
    } = await this.makeRPC("consume", {rtpCapabilities })

    let codecOptions = {}
    const consumer = await transport.consume({
      id,
      producerId,
      kind,
      rtpParameters,
      codecOptions,
    })
    const stream = new MediaStream()
    stream.addTrack(consumer.track)
    return stream
  }

}

export default MediasoupClient
