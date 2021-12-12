const z = require('zero-fill')
const {SubtitleParser} = require('matroska-subtitles')
const {Translate} = require('@google-cloud/translate').v2;
const FS = require('fs')
const Path = require('path')

// translator("hello world!\n where is my cousins \n I don't know! \n", {from: 'en', to: 'zh-cn'}).then((res: any) => {
    // 	console.log(res.text)
    // }).catch((err: any) => console.error(err))
// console.log("hello again!")


class BatchTextTranslator {
    constructor() {
        this.taskQueue = []
        this.batchSize = 2
        this.batchTimeInterval = 8000
        this.intervalID = -1
        this.extractionFinished = false
        this.translate = new Translate()
    }
    queueTask(index, track, sub) {
        this.taskQueue.push({index, track, sub})
    }
    setExtractionFinished() {
        this.extractionFinished = true
    }
    // https://stackoverflow.com/questions/9763441/milliseconds-to-time-in-javascript
    msToTime (s) {
        const ms = s % 1000
        s = (s - ms) / 1000
        const secs = s % 60
        s = (s - secs) / 60
        const mins = s % 60
        const hrs = (s - mins) / 60

        return z(2, hrs) + ':' + z(2, mins) + ':' + z(2, secs) + ',' + z(3, ms)
    }
    batchTranslate() {
        const batchTasks = []
        const curSize = this.taskQueue.length
        for (let i = 0; i < this.batchSize && i < curSize; i++) {
            const task = this.taskQueue.shift()
            if (task === undefined) {
                continue
            }
            batchTasks.push(task)
        }
        if (batchTasks.length == 0) {
            return
        }

        const requestTextArray = []
        batchTasks.map((task) => {
            task.sub.text = task.sub.text.replace(/[\r\n]+/g, " ")
            requestTextArray.push(task.sub.text)
        })

        this.translate.translate(requestTextArray, 'zh-cn').then((res) => {
            let [translations] = res
            for (let i = 0; i < translations.length; i++) {
                const {index, track, sub} = batchTasks[i]
                track.file.write(`${index}\r\n`)
                track.file.write(`${this.msToTime(sub.time)} --> ${this.msToTime(sub.time + sub.duration)}\r\n`)
                console.log(`${sub.text} --> ${translations[i].replace(/[\r\n]+/g, " ")}`)
                track.file.write(`${translations[i]}\r\n`)
                track.file.write(`${sub.text}\r\n\r\n`)
            }
            console.log(`translation progress ${this.taskQueue.length}`)
        }).catch((err) => console.error(err))
    }
    async run() {
        while (true) {
            this.batchTranslate()
            if (this.taskQueue.length == 0 && this.extractionFinished) {
                console.log("translation finished")
                return true
            }
            await new Promise(r => setTimeout(r, this.batchTimeInterval))
        }
    }
}

class MkvSubtitleExtractor {
    constructor(batchTextTranslator) {
        this.batchTextTranslator = batchTextTranslator
    }
    extract(mkvPath, outputDir) {
        return new Promise((resolve, reject) => {
            let designatedTrackNumber = -1

            const tracks = new Map()
            const subs = new SubtitleParser()

            const dir = outputDir || Path.dirname(mkvPath)
            const name = Path.basename(mkvPath, Path.extname(mkvPath))

            const translatorFinishFuture = this.batchTextTranslator.run()

            // create srt path from language suffix
            const srtPath = function (language) {
                const languageSuffix = language ? '.' + language : ''
                return Path.join(dir, name + languageSuffix + '.srt')
            }

            subs.once('tracks', (tracks_) => {
                console.log(`got tracks: ${JSON.stringify(tracks_)}`)
                tracks_.forEach(track => {
                    // sometimes `und` (undefined) is used as the default value, instead of leaving the tag unassigned
                    const language = track.language !== 'und' ? track.language : null
                    if (language && language != 'en') {
                        return
                    }
                    if (designatedTrackNumber != -1) {
                        return
                    }

                    designatedTrackNumber = track.number
                    let subtitlePath = srtPath(language)

                    tracks.set(track.number, {
                        index: 1,
                        file: FS.createWriteStream(subtitlePath),
                        language
                    })
                })
            })

            subs.on('subtitle', (sub, trackNumber) => {
                if (trackNumber != designatedTrackNumber) {
                    return
                }
                const track = tracks.get(trackNumber)
                this.batchTextTranslator.queueTask(track.index++, track, sub)
            })

            subs.on('finish', () => {
                console.log("receive finish")
                this.batchTextTranslator.setExtractionFinished()
                translatorFinishFuture.then(() => {
                    const finishTracks = []
                    tracks.forEach((track, i) => {
                        track.file.end()
                        finishTracks.push({number: i, path: track.file.path, language: track.language})
                    })
                    resolve(finishTracks)
                })

            })
            const file = FS.createReadStream(mkvPath)
            file.on('error', (err) => reject(err))
            file.pipe(subs)
            console.log(`starting translation for file ${mkvPath}`)
        })
    }
}

const recursiveScanFiles = (directory) => {
    const filePaths = []
    FS.readdirSync(directory).forEach((File) => {
        const Absolute = Path.join(directory, File);
        if (FS.statSync(Absolute).isDirectory()) {
            filePaths.push(...recursiveScanFiles(Absolute))
        } else {
            filePaths.push(Absolute);
        }
    })
    return filePaths
}

function main() {
    const args = process.argv.slice(2)
    const files = recursiveScanFiles(args[0])
    console.log(`scaned files is ${JSON.stringify(files)}`)
    files.forEach(file => {
        const extName = Path.extname(file)
        if (extName == '.mkv') {
            console.log(`scaning file ${file}`)
            const pathName = Path.dirname(file)
            const mkvSubtitleExtractor = new MkvSubtitleExtractor(new BatchTextTranslator())
            mkvSubtitleExtractor.extract(file, pathName).then(() => {
                console.log("subtitle extraction finished")
            }).catch((err) => console.error(err))
        }
    })
}

main()

