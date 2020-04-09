import { Component, Fragment, useEffect, useRef, useState } from "react";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { faCircle, faPlay } from "@fortawesome/free-solid-svg-icons";
import SessionClient from "../lib/SessionClient";
import StartAudioContext from "startaudiocontext";

type Props = {
  sessionClient: SessionClient;
  onProduceRequest: Function;
  onConsumeRequest: Function;
  producerId : string;
};

const Audio = (props: Props) => {

  const { sessionClient, producerId } = props

  const [producing, setProducing] = useState(false)
  const [consuming, setConsuming] = useState(false)

  const audioContext = new AudioContext()
  const canvasRef = useRef(null)
  const audioRef = useRef(null)
  const requestRef = useRef(null)
  const bufRef = useRef(null)
  const analyserRef = useRef(null)

  const draw = time => {
    requestRef.current = requestAnimationFrame(draw)

    const canvas = canvasRef.current
    const analyser = analyserRef.current
    const buffer = bufRef.current

    if(!analyser || !canvas)
      return

    const ctx = canvas.getContext('2d')

    ctx.fillStyle = "rgb(200, 200, 200)"
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.lineWidth = 2
    ctx.strokeStyle = "rgb(0, 0, 0)"

    //update buffer with analyser
    analyser.getByteTimeDomainData(buffer)

    ctx.beginPath();

    const sliceWidth = canvas.width * 1.0 / buffer.length;
    let x = 0;

    for (var i = 0; i < buffer.length; i++) {
      let v = buffer[i] / 128.0
      let y = v * canvas.height / 2

      if (i === 0) 
        ctx.moveTo(x, y)
      else
        ctx.lineTo(x, y)

      x += sliceWidth
    }

    ctx.lineTo(canvas.width, canvas.height / 2)
    ctx.stroke()

  }

  useEffect(() => {
    requestRef.current = requestAnimationFrame(draw)

    StartAudioContext(audioContext).then(()=>{
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048
      analyserRef.current = analyser 
      bufRef.current = new Uint8Array(analyser.frequencyBinCount)
    })

    return () => cancelAnimationFrame(requestRef.current)
  }, []) // Make sure the effect runs only once

  useEffect(() => {
    setProducing(sessionClient.isAudioProducer())
    return () => {}
  }, [props.producerId]) // Make sure the effect runs only once

  const onProduceClick = (ev) => {
    props.onProduceRequest()
  }

  const onConsumeClick = async () => {
    const stream = await props.onConsumeRequest()
    const analyser = analyserRef.current
    const context = analyser.context
    
    const source = context.createMediaStreamSource(stream)
    source.connect(analyser)
    source.connect(context.destination)
    // Have to add the stream to an audio to make it work...
    const audio = audioRef.current
    audio.srcObject = stream
    setConsuming(true)
    
  }

  const showProduceButton = true //(producerId==='') || producer
  const showConsumeButton = true //(producerId!=='') && !producer
  return (
    <div className="audio-stream">
      {showProduceButton && <FontAwesomeIcon onClick={onProduceClick} icon={faCircle} size="3x" />}
      {showConsumeButton && <>
        <FontAwesomeIcon onClick={onConsumeClick} icon={faPlay} size="3x" />
        <canvas ref={canvasRef} width={100} height={50} />
        <audio ref={audioRef} ></audio>
      </>
      }
    </div>
  );
}

export default Audio;
