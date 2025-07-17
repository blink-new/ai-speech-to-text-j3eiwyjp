import { useState, useRef, useEffect, useCallback } from 'react'
import { Mic, MicOff, Square, Play, Pause, Download, Copy, Trash2, Languages, Volume2 } from 'lucide-react'
import { Button } from './components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from './components/ui/card'
import { Textarea } from './components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './components/ui/select'
import { Badge } from './components/ui/badge'
import { Progress } from './components/ui/progress'
import { Separator } from './components/ui/separator'
import { blink } from './blink/client'
import toast, { Toaster } from 'react-hot-toast'

interface TranscriptionSession {
  id: string
  text: string
  timestamp: Date
  language: string
  duration: number
}

const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'ru', name: 'Russian' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese' }
]

function App() {
  const [user, setUser] = useState(null)
  const [loading, setLoading] = useState(true)
  const [isRecording, setIsRecording] = useState(false)
  const [isPaused, setIsPaused] = useState(false)
  const [transcriptionText, setTranscriptionText] = useState('')
  const [isTranscribing, setIsTranscribing] = useState(false)
  const [selectedLanguage, setSelectedLanguage] = useState('en')
  const [recordingDuration, setRecordingDuration] = useState(0)
  const [audioLevel, setAudioLevel] = useState(0)
  const [sessions, setSessions] = useState<TranscriptionSession[]>([])
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const audioChunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const animationFrameRef = useRef<number | null>(null)
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Auth state management
  useEffect(() => {
    const unsubscribe = blink.auth.onAuthStateChanged((state) => {
      setUser(state.user)
      setLoading(state.isLoading)
    })
    return unsubscribe
  }, [])

  const loadSessionsFromLocalStorage = useCallback(() => {
    try {
      const stored = localStorage.getItem(`transcription_sessions_${user.id}`)
      if (stored) {
        const sessions = JSON.parse(stored)
        setSessions(sessions.map(session => ({
          ...session,
          timestamp: new Date(session.timestamp)
        })))
      }
    } catch (error) {
      console.error('Failed to load sessions from local storage:', error)
    }
  }, [user])

  const loadSessions = useCallback(async () => {
    try {
      // Try to load from database first
      const data = await blink.db.transcriptionSessions.list({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
        limit: 10
      })
      setSessions(data.map(session => ({
        id: session.id,
        text: session.text,
        timestamp: new Date(session.createdAt),
        language: session.language,
        duration: session.duration
      })))
    } catch (error) {
      console.error('Failed to load sessions from database:', error)
      // Fallback to local storage
      loadSessionsFromLocalStorage()
    }
  }, [user, loadSessionsFromLocalStorage])

  const saveSessionsToLocalStorage = useCallback((sessions: TranscriptionSession[]) => {
    try {
      localStorage.setItem(`transcription_sessions_${user.id}`, JSON.stringify(sessions))
    } catch (error) {
      console.error('Failed to save sessions to local storage:', error)
    }
  }, [user])

  // Load previous sessions
  useEffect(() => {
    if (user) {
      loadSessions()
    }
  }, [user, loadSessions])

  const saveSession = async (text: string, duration: number) => {
    const newSession: TranscriptionSession = {
      id: `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      text,
      timestamp: new Date(),
      language: selectedLanguage,
      duration
    }

    try {
      // Try to save to database first
      const dbSession = await blink.db.transcriptionSessions.create({
        userId: user.id,
        text,
        language: selectedLanguage,
        duration,
        createdAt: new Date().toISOString()
      })
      
      // Update with database ID if successful
      newSession.id = dbSession.id
      setSessions(prev => [newSession, ...prev.slice(0, 9)])
      toast.success('Session saved!')
    } catch (error) {
      console.error('Failed to save session to database:', error)
      
      // Fallback to local storage
      const updatedSessions = [newSession, ...sessions.slice(0, 9)]
      setSessions(updatedSessions)
      saveSessionsToLocalStorage(updatedSessions)
      toast.success('Session saved locally!')
    }
  }

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100
        } 
      })
      
      streamRef.current = stream
      audioChunksRef.current = []
      
      // Set up audio analysis for visual feedback
      audioContextRef.current = new AudioContext()
      analyserRef.current = audioContextRef.current.createAnalyser()
      const source = audioContextRef.current.createMediaStreamSource(stream)
      source.connect(analyserRef.current)
      analyserRef.current.fftSize = 256
      
      // Start audio level monitoring
      monitorAudioLevel()
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm;codecs=opus'
      })
      
      mediaRecorderRef.current = mediaRecorder
      
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data)
        }
      }
      
      mediaRecorder.onstop = async () => {
        await processRecording()
      }
      
      mediaRecorder.start(1000) // Collect data every second
      setIsRecording(true)
      setIsPaused(false)
      setRecordingDuration(0)
      
      // Start duration timer
      durationIntervalRef.current = setInterval(() => {
        setRecordingDuration(prev => prev + 1)
      }, 1000)
      
      toast.success('Recording started!')
    } catch (error) {
      console.error('Failed to start recording:', error)
      toast.error('Failed to access microphone')
    }
  }

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop()
      setIsRecording(false)
      setIsPaused(false)
      
      // Clean up
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop())
      }
      if (audioContextRef.current) {
        audioContextRef.current.close()
      }
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current)
      }
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current)
      }
      
      setAudioLevel(0)
    }
  }

  const pauseRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      if (isPaused) {
        mediaRecorderRef.current.resume()
        setIsPaused(false)
        // Resume duration timer
        durationIntervalRef.current = setInterval(() => {
          setRecordingDuration(prev => prev + 1)
        }, 1000)
      } else {
        mediaRecorderRef.current.pause()
        setIsPaused(true)
        // Pause duration timer
        if (durationIntervalRef.current) {
          clearInterval(durationIntervalRef.current)
        }
      }
    }
  }

  const monitorAudioLevel = () => {
    if (analyserRef.current) {
      const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount)
      analyserRef.current.getByteFrequencyData(dataArray)
      
      const average = dataArray.reduce((sum, value) => sum + value, 0) / dataArray.length
      setAudioLevel(Math.min(100, (average / 128) * 100))
      
      animationFrameRef.current = requestAnimationFrame(monitorAudioLevel)
    }
  }

  const processRecording = async () => {
    if (audioChunksRef.current.length === 0) return
    
    setIsTranscribing(true)
    
    try {
      const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' })
      
      // Convert to base64 for transcription
      const base64Audio = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
          const dataUrl = reader.result as string
          const base64Data = dataUrl.split(',')[1]
          resolve(base64Data)
        }
        reader.onerror = reject
        reader.readAsDataURL(audioBlob)
      })
      
      // Transcribe using Blink AI
      const { text } = await blink.ai.transcribeAudio({
        audio: base64Audio,
        language: selectedLanguage
      })
      
      setTranscriptionText(text)
      
      // Save session
      await saveSession(text, recordingDuration)
      
      toast.success('Transcription completed!')
    } catch (error) {
      console.error('Transcription failed:', error)
      toast.error('Transcription failed. Please try again.')
    } finally {
      setIsTranscribing(false)
    }
  }

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      toast.success('Copied to clipboard!')
    } catch (error) {
      toast.error('Failed to copy to clipboard')
    }
  }

  const downloadText = (text: string, filename: string = 'transcription.txt') => {
    const blob = new Blob([text], { type: 'text/plain' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
    toast.success('Downloaded!')
  }

  const deleteSession = async (sessionId: string) => {
    try {
      // Try to delete from database first
      await blink.db.transcriptionSessions.delete(sessionId)
      const updatedSessions = sessions.filter(s => s.id !== sessionId)
      setSessions(updatedSessions)
      toast.success('Session deleted!')
    } catch (error) {
      console.error('Failed to delete session from database:', error)
      
      // Fallback to local storage deletion
      const updatedSessions = sessions.filter(s => s.id !== sessionId)
      setSessions(updatedSessions)
      saveSessionsToLocalStorage(updatedSessions)
      toast.success('Session deleted locally!')
    }
  }

  const formatDuration = (seconds: number) => {
    const mins = Math.floor(seconds / 60)
    const secs = seconds % 60
    return `${mins}:${secs.toString().padStart(2, '0')}`
  }

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Card className="w-full max-w-md">
          <CardHeader className="text-center">
            <CardTitle className="text-2xl font-bold">Welcome to AI Speech to Text</CardTitle>
            <p className="text-muted-foreground">Please sign in to start transcribing</p>
          </CardHeader>
          <CardContent className="text-center">
            <Button onClick={() => blink.auth.login()} className="w-full">
              Sign In
            </Button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background font-['Inter']">
      <Toaster position="top-right" />
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary rounded-lg flex items-center justify-center">
              <Mic className="w-6 h-6 text-primary-foreground" />
            </div>
            <div>
              <h1 className="text-xl font-bold">AI Speech to Text</h1>
              <p className="text-sm text-muted-foreground">Convert speech to text with AI</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">Welcome, {user.email}</span>
            <Button variant="outline" size="sm" onClick={() => blink.auth.logout()}>
              Sign Out
            </Button>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-4 py-8">
        <div className="grid lg:grid-cols-3 gap-8">
          {/* Main Recording Interface */}
          <div className="lg:col-span-2 space-y-6">
            {/* Recording Controls */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Volume2 className="w-5 h-5" />
                  Recording Studio
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Language Selection */}
                <div className="flex items-center gap-4">
                  <Languages className="w-5 h-5 text-muted-foreground" />
                  <Select value={selectedLanguage} onValueChange={setSelectedLanguage}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {SUPPORTED_LANGUAGES.map(lang => (
                        <SelectItem key={lang.code} value={lang.code}>
                          {lang.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Audio Level Indicator */}
                {isRecording && (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="text-muted-foreground">Audio Level</span>
                      <span className="font-mono">{Math.round(audioLevel)}%</span>
                    </div>
                    <Progress value={audioLevel} className="h-2" />
                  </div>
                )}

                {/* Recording Duration */}
                {isRecording && (
                  <div className="text-center">
                    <div className="text-3xl font-mono font-bold text-primary">
                      {formatDuration(recordingDuration)}
                    </div>
                    <div className="flex items-center justify-center gap-2 mt-2">
                      <div className={`w-3 h-3 rounded-full ${isPaused ? 'bg-yellow-500' : 'bg-red-500 animate-pulse'}`} />
                      <span className="text-sm text-muted-foreground">
                        {isPaused ? 'Paused' : 'Recording'}
                      </span>
                    </div>
                  </div>
                )}

                {/* Control Buttons */}
                <div className="flex items-center justify-center gap-4">
                  {!isRecording ? (
                    <Button
                      onClick={startRecording}
                      size="lg"
                      className="h-16 w-16 rounded-full"
                      disabled={isTranscribing}
                    >
                      <Mic className="w-8 h-8" />
                    </Button>
                  ) : (
                    <>
                      <Button
                        onClick={pauseRecording}
                        variant="outline"
                        size="lg"
                        className="h-12 w-12 rounded-full"
                      >
                        {isPaused ? <Play className="w-6 h-6" /> : <Pause className="w-6 h-6" />}
                      </Button>
                      <Button
                        onClick={stopRecording}
                        variant="destructive"
                        size="lg"
                        className="h-16 w-16 rounded-full"
                      >
                        <Square className="w-8 h-8" />
                      </Button>
                    </>
                  )}
                </div>

                {isTranscribing && (
                  <div className="text-center">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary mx-auto mb-2"></div>
                    <p className="text-sm text-muted-foreground">Transcribing audio...</p>
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Transcription Result */}
            {transcriptionText && (
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Transcription Result</CardTitle>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => copyToClipboard(transcriptionText)}
                      >
                        <Copy className="w-4 h-4 mr-2" />
                        Copy
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => downloadText(transcriptionText)}
                      >
                        <Download className="w-4 h-4 mr-2" />
                        Download
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <Textarea
                    value={transcriptionText}
                    onChange={(e) => setTranscriptionText(e.target.value)}
                    placeholder="Your transcription will appear here..."
                    className="min-h-32 resize-none"
                  />
                </CardContent>
              </Card>
            )}
          </div>

          {/* Session History */}
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Recent Sessions</CardTitle>
              </CardHeader>
              <CardContent>
                {sessions.length === 0 ? (
                  <p className="text-center text-muted-foreground py-8">
                    No sessions yet. Start recording to see your history here.
                  </p>
                ) : (
                  <div className="space-y-4">
                    {sessions.map((session) => (
                      <div key={session.id} className="border rounded-lg p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <Badge variant="secondary">
                            {SUPPORTED_LANGUAGES.find(l => l.code === session.language)?.name}
                          </Badge>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => deleteSession(session.id)}
                          >
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </div>
                        
                        <p className="text-sm line-clamp-3">{session.text}</p>
                        
                        <Separator />
                        
                        <div className="flex items-center justify-between text-xs text-muted-foreground">
                          <span>{session.timestamp.toLocaleDateString()}</span>
                          <span>{formatDuration(session.duration)}</span>
                        </div>
                        
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => copyToClipboard(session.text)}
                            className="flex-1"
                          >
                            <Copy className="w-3 h-3 mr-1" />
                            Copy
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => downloadText(session.text, `transcription-${session.id}.txt`)}
                            className="flex-1"
                          >
                            <Download className="w-3 h-3 mr-1" />
                            Download
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  )
}

export default App