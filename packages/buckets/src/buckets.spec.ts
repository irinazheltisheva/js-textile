import { Context } from '@textile/context'
import { PrivateKey } from '@textile/crypto'
import { SignupResponse } from '@textile/hub-grpc/api/hubd/pb/hubd_pb'
import AbortController from 'abort-controller'
import { isBrowser, isNode } from 'browser-or-node'
import { expect } from 'chai'
import fs from 'fs'
import path from 'path'
import { Duplex } from 'stream'
import { CHUNK_SIZE, genChunks } from './api'
import { Buckets } from './buckets'
import { createKey, signUp } from './spec.util'
import { AbortError, CreateResponse } from './types'

// Settings for localhost development and testing
const addrApiurl = 'http://127.0.0.1:3007'
const addrGatewayUrl = 'http://127.0.0.1:8006'
const wrongError = new Error('wrong error!')
const rightError = new Error('right error!')
const sessionSecret = 'hubsession'

describe('Buckets utils...', function () {
  it('should create max-sized chunks from an input Uin8Array', function () {
    const original = Uint8Array.from(Array.from(Array(1234), (_, i) => i * i))
    let it = genChunks(original, 1500)
    let value = it.next().value
    expect(value.byteLength).to.equal(1234)

    it = genChunks(original, 50)
    for (const value of it) {
      expect(value.byteLength).to.be.lessThan(51)
    }

    // Should be two chunks, one of size 1230, and one of size 4
    it = genChunks(original, 1230)
    value = it.next().value
    expect(value.byteLength).to.equal(1230)
    value = it.next().value
    expect(value.byteLength).to.equal(4)

    const small = Uint8Array.from(Array.from(Array(64), (_, i) => i * i))
    const arr = Array.from(genChunks(small, 16))
    expect(arr).to.have.lengthOf(4)
  })
})

describe('Buckets...', function () {
  const ctx = new Context(addrApiurl)
  const client = new Buckets(ctx)
  let buck: CreateResponse
  let fileSize: number

  let dev: SignupResponse.AsObject
  const apiKeyInfo = { key: '' }

  before(async function () {
    this.timeout(5000)
    const user = await signUp(ctx, addrGatewayUrl, sessionSecret)
    ctx.withSession(user.user?.session)
    if (!user.user) throw new Error('user signup error')
    dev = user.user
    const tmp = new Context(addrApiurl).withSession(dev.session)
    const { keyInfo } = await createKey(tmp, 'KEY_TYPE_USER')
    if (!keyInfo) return
    apiKeyInfo.key = keyInfo.key
  })

  describe('editing', function () {
    it('should open a bucket by name without thread info', async function () {
      const { root, threadID } = await client.getOrCreate('createbuck', {
        threadName: 'buckets',
        encrypted: false,
      })
      expect(threadID).to.not.be.undefined
      expect(root).to.have.ownProperty('key')
      expect(root).to.have.ownProperty('path')
      expect(root).to.have.ownProperty('createdAt')
      expect(root).to.have.ownProperty('updatedAt')
    })

    it('should create a new bucket on open thread', async function () {
      // Check that we're empty
      const list = await client.list()
      expect(list).to.have.length(1)
      // Now create a bucket
      buck = await client.create('mybuck')
      expect(buck).to.have.ownProperty('root')
      expect(buck.root).to.have.ownProperty('key')
      expect(buck.root).to.have.ownProperty('path')
      expect(buck.root).to.have.ownProperty('createdAt')
      expect(buck.root).to.have.ownProperty('updatedAt')
    })

    it('should list buckets', async function () {
      const roots = await client.list()
      expect(roots).to.have.length(2)
      const index = roots[0].key === buck.root?.key ? 0 : 1
      const root = roots[index]
      expect(root).to.have.ownProperty('key', buck.root?.key)
      expect(root).to.have.ownProperty('path', buck.root?.path)
      expect(root).to.have.ownProperty('createdAt', buck.root?.createdAt)
      expect(root).to.have.ownProperty('updatedAt', buck.root?.updatedAt)
    })

    it('should list empty bucket content at path', async function () {
      // Mostly empty
      const res = await client.listPath(buck.root?.key || '', '')
      expect(res).to.have.ownProperty('root')
      expect(res.root).to.not.be.undefined
      expect(res.item?.isDir).to.be.true
      expect(res.item?.items).to.have.length(1) // Includes .textileseed
    })

    it('should push data from filesystem on node', async function () {
      if (isBrowser) return this.skip()
      this.timeout(5000)
      const pth = path.join(__dirname, '../../..', 'testdata')
      fileSize = fs.statSync(path.join(pth, 'file1.jpg')).size
      let stream = fs.createReadStream(path.join(pth, 'file1.jpg'))
      const rootKey = buck.root?.key || ''
      let length = 0

      // Bucket path
      const res = await client.pushPath(rootKey, 'dir1/file1.jpg', stream, {
        progress: (num) => (length = num || 0),
      })
      expect(length).to.equal(fileSize)
      expect(res.path).to.not.be.undefined
      expect(res.root).to.not.be.undefined

      // Nested bucket path
      stream = fs.createReadStream(path.join(pth, 'file2.jpg'))
      const { root } = await client.pushPath(
        rootKey,
        'path/to/file2.jpg',
        stream,
      )
      expect(root).to.not.be.undefined

      // Root dir
      const rep = await client.listPath(rootKey, '')
      expect(rep.item?.isDir).to.be.true
      expect(rep.item?.items).to.have.length(3) // Includes .textileseed
    })

    it('should push data from file API in browser', async function () {
      if (isNode) return this.skip()
      const parts = [
        new Blob(['you construct a file...'], { type: 'text/plain' }),
        ' Same way as you do with blob',
        new Uint16Array([33]),
      ]
      // Construct a file
      const file = new File(parts, 'file1.txt')
      const rootKey = buck.root?.key || ''
      let length = 0

      // Bucket path
      const res = await client.pushPath(rootKey, 'dir1/file1.jpg', file, {
        progress: (num) => (length = num || 0),
      })
      expect(length).to.equal(54)
      expect(res.path).to.not.be.undefined
      expect(res.root).to.not.be.undefined

      // Nested bucket path
      // @note: We're reusing file here...
      const { root } = await client.pushPath(rootKey, 'path/to/file2.jpg', file)
      expect(root).to.not.be.undefined

      // Root dir
      const rep = await client.listPath(rootKey, '')
      expect(rep.item?.isDir).to.be.true
      expect(rep.item?.items).to.have.length(3)
    })

    it('should list (nested) files within a bucket', async function () {
      const rootKey = buck.root?.key || ''

      // Nested dir
      let rep = await client.listPath(rootKey, 'dir1')
      expect(rep.item?.isDir).to.be.true
      expect(rep.item?.items).to.have.length(1)

      // File
      rep = await client.listPath(rootKey, 'dir1/file1.jpg')
      expect(rep.item?.path.endsWith('file1.jpg')).to.be.true
      expect(rep.item?.isDir).to.be.false

      // Recursive dir
      rep = await client.listPath(rootKey, '', 3)
      expect(rep.item?.isDir).to.be.true
      expect(rep.item?.items).to.have.length(3)

      // Recursive dir
      // [
      //   '.textileseed',
      //   'dir1',
      //   'dir1/file1.jpg',
      //   'path',
      //   'path/to',
      //   'path/to/file2.jpg'
      // ]
      let list = await client.listPathFlat(rootKey, '')
      expect(list).to.have.length(6)
      expect(list).to.contain('dir1/file1.jpg')

      list = await client.listPathFlat(rootKey, '', false)
      expect(list).to.have.length(3)
    })

    it('should pull files by path and write to file on node', async function () {
      if (isBrowser) return this.skip()
      // Bucket path
      const rootKey = buck.root?.key || ''
      let length = 0

      // Bucket path
      const chunks = client.pullPath(rootKey, 'dir1/file1.jpg', {
        progress: (num) => (length = num || 0),
      })
      const pth = path.join(__dirname, '../../..', 'testdata')
      const stream = fs.createWriteStream(path.join(pth, 'output.jpg'))
      // Should be an AsyncIterable
      for await (const chunk of chunks) {
        stream.write(chunk)
      }
      stream.close()
      expect(length).to.equal(fileSize)
      // const stored = fs.statSync(path.join(pth, 'file1.jpg'))
      // const written = fs.statSync(path.join(pth, 'output.jpg'))
      // expect(stored.size).to.equal(written.size)
      fs.unlinkSync(path.join(pth, 'output.jpg'))

      // Should throw correctly when the file isn't available
      try {
        const more = client.pullPath(rootKey, 'dir1/nope.jpg')
        for await (const chk of more) {
          expect(chk).to.not.be.undefined
        }
        throw wrongError
      } catch (err) {
        expect(err).to.not.equal(wrongError)
        expect(err.toString()).to.include('nope.jpg')
      }

      // Should be an AsyncIterator
      const more = client.pullPath(rootKey, 'dir1/file1.jpg')
      const { value } = await more.next()
      expect(value).to.not.be.undefined
    })

    it('should remove files by path', async function () {
      const rootKey = buck.root?.key || ''
      const wrongRoot = buck.root
      await client.removePath(rootKey, 'path/to/file2.jpg')
      try {
        await client.listPath(rootKey, 'path/to/file2.jpg')
        throw wrongError
      } catch (err) {
        expect(err).to.not.equal(wrongError)
      }
      let list = await client.listPath(rootKey, '')
      expect(list.item?.items).to.have.length(3) // Includes .textileseed
      await client.removePath(rootKey, 'path')
      try {
        await client.listPath(rootKey, 'path')
        throw wrongError
      } catch (err) {
        expect(err).to.not.equal(wrongError)
      }
      list = await client.listPath(rootKey, '')
      expect(list.item?.items).to.have.length(2) // Includes .textileseed

      try {
        await client.removePath(rootKey, 'path', { root: wrongRoot })
        throw wrongError
      } catch (err) {
        expect(err.message).to.equal('update is non-fast-forward')
      }
    })

    it('should push data from Buffer', async function () {
      const content = 'some content'
      const file = { path: '/index.html', content: Buffer.from(content) }

      const rootKey = buck.root?.key || ''

      const { root } = await client.pushPath(rootKey, 'index.html', file)
      expect(root).to.not.be.undefined

      // Root dir
      const rep = await client.listPath(rootKey, '')
      expect(rep.item?.isDir).to.be.true
      expect(rep.item?.items).to.have.length(3)
    })

    it('should list bucket links', async function () {
      const rootKey = buck.root?.key || ''

      const rep = await client.links(rootKey)
      expect(rep.url).to.not.equal('')
      expect(rep.ipns).to.not.equal('')
    })

    it('should remove an entire bucket', async function () {
      const rootKey = buck.root?.key || ''
      const rep = await client.listPath(rootKey, 'dir1/file1.jpg')
      expect(rep).to.not.be.undefined
      await client.remove(rootKey)
      try {
        await client.listPath(rootKey, 'dir1/file1.jpg')
        throw wrongError
      } catch (err) {
        expect(err).to.not.equal(wrongError)
      }
    })
  })

  describe('multiple pushes', function () {
    it('should throw if roots are out of sync/order', async function () {
      if (isBrowser) return this.skip()
      const { root } = await client.getOrCreate('pushes')

      // Grab a reference to a relatively large file
      const pth = path.join(__dirname, '../../..', 'testdata')
      fileSize = fs.statSync(path.join(pth, 'file1.jpg')).size
      const stream1 = fs.createReadStream(path.join(pth, 'file1.jpg'))
      const rootKey = root?.key || ''

      // Now create a relatively small stream that should finish first
      const stream2 = new Duplex()
      stream2.push(Buffer.from('some small amount of text'))
      stream2.push(Buffer.from('that spans two buffers'))
      stream2.push(null)

      // Run them in series
      await Promise.resolve()
        .then(() =>
          client.pushPath(rootKey, 'dir1/file1.jpg', stream1, { root }),
        )
        .then(() =>
          client.pushPath(rootKey, 'dir1/file2.txt', stream2, { root }),
        )
        .then(() => {
          throw new Error('wrong error')
        }) // This should never fire
        // Because we should jump down to this first
        .catch((err) => expect(err.message).to.include('non-fast-forward'))

      // Confirm that our second-level dir only includes one of them
      const { item } = await client.listPath(rootKey, '')
      expect(item?.items[1].items).to.have.length(1)
    })

    it.skip('should not be able to push in parallel', async function () {
      //TODO: Right now, the Go client doesn't "locK" a bucket for pushes, this is something
      // we should add/support to ensure buckets pushed in parallel don't corrupt things
      if (isBrowser) return this.skip()
      const { root } = await client.getOrCreate('pushes')

      // Grab a reference to a relatively large file
      const pth = path.join(__dirname, '../../..', 'testdata')
      fileSize = fs.statSync(path.join(pth, 'file1.jpg')).size
      const stream1 = fs.createReadStream(path.join(pth, 'file1.jpg'))
      const rootKey = root?.key || ''

      // Now create a relatively small stream that should finish first
      const stream2 = new Duplex()
      stream2.push(Buffer.from('some small amount of text'))
      stream2.push(Buffer.from('that spans two buffers'))
      stream2.push(null)

      try {
        await Promise.all([
          // Note the names are different from above test
          client.pushPath(rootKey, 'dir1/file3.jpg', stream1),
          client.pushPath(rootKey, 'dir1/file4.txt', stream2),
        ])
        throw new Error('wrong error')
      } catch (err) {
        expect(err.message).to.include('non-fast-forward')
      }
      // Confirm that our second-level dir only includes one of them
      const { item } = await client.listPath(rootKey, '')
      expect(item?.items[1].items).to.have.length(1)
    })
  })

  describe('aborting', function () {
    it('should allow an abort controler to signal a cancel event on a push', async function () {
      const { root } = await client.getOrCreate('aborted')

      // Create an infinite stream of bytes
      async function* stream(): AsyncGenerator<Buffer, void, unknown> {
        while (true) {
          yield Buffer.from('data')
          await new Promise((resolve) => setTimeout(resolve, 100))
        }
      }

      const rootKey = root?.key || ''
      const controller = new AbortController()
      const { signal } = controller
      setTimeout(() => controller.abort(), 100) // Wait long enough to get the thing started
      try {
        await client.pushPath(rootKey, 'dir1/file1.jpg', stream(), {
          root,
          signal,
        })
        throw new Error('wrong error')
      } catch (err) {
        expect(err).to.equal(AbortError)
      }
      try {
        // If the above pushPath was indeed killed, then the following will error, otherwise,
        // it should timeout!
        await client.listPath(rootKey, 'dir1/file1.jpg')
        throw new Error('wrong error')
      } catch (err) {
        expect(err.message).to.include('no link named')
      }
    })
  })

  describe('sharing', function () {
    const bob = PrivateKey.fromRandom()
    const bobPubKey = bob.public.toString()
    const alice = PrivateKey.fromRandom()
    let aliceBuckets: Buckets | undefined
    let bobBuckets: Buckets | undefined
    let aliceThread: string | undefined
    let rootKey: string | undefined
    const sharedPath = 'path/to'
    const sharedFile = 'path/to/file2.jpg'
    const privatePath = 'dir1/file1.jpg'
    const pth = path.join(__dirname, '../../..', 'testdata')

    before(async function () {
      this.timeout(10000)
      if (isBrowser) return this.skip()
      aliceBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await aliceBuckets.getToken(alice)
      bobBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await bobBuckets.getToken(bob)
      const { root, threadID } = await aliceBuckets.getOrCreate('createbuck')
      aliceThread = threadID

      // scope bob's client to the same thread
      bobBuckets.withThread(aliceThread)

      if (!root) throw Error('bucket creation failed')
      rootKey = root.key

      // Push private file for only alice
      let stream = fs.createReadStream(path.join(pth, 'file1.jpg'))
      await aliceBuckets.pushPath(rootKey, privatePath, stream)

      // Push file to be shared with bob
      stream = fs.createReadStream(path.join(pth, 'file2.jpg'))
      await aliceBuckets.pushPath(rootKey, sharedFile, stream)
    })

    it('grant peer2 write access', async function () {
      if (isBrowser) return this.skip()
      if (!aliceThread || !rootKey) throw Error('setup failed')

      aliceBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await aliceBuckets.getToken(alice)
      aliceBuckets.withThread(aliceThread)

      // Update access roles to grant bob access
      const roles = new Map()
      roles.set(bobPubKey, 2)
      // Grants access at 'path/to'
      await aliceBuckets.pushPathAccessRoles(rootKey, sharedPath, roles)

      // Check that our pulled permissions are as expected
      const shared = await aliceBuckets.pullPathAccessRoles(rootKey, sharedPath)
      expect(shared.get(bobPubKey)).to.equal(2)
    })

    it('add a new file into a shared path should fail', async function () {
      if (isBrowser) return this.skip()
      if (!aliceThread || !rootKey) throw Error('setup failed')

      bobBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await bobBuckets.getToken(bob)
      bobBuckets.withThread(aliceThread)

      const { root } = await bobBuckets.listPath(rootKey, '')
      try {
        // Use default highwatermark of CHUNK_SIZE!
        const stream = fs.createReadStream(path.join(pth, 'file2.jpg'), {
          highWaterMark: CHUNK_SIZE,
        })
        await bobBuckets.pushPath(rootKey, 'path/to/bobby.jpg', stream, {
          root,
        })
        throw wrongError
      } catch (err) {
        expect(err).to.not.equal(wrongError)
        expect(err.message).to.include('permission denied')
      }
    })

    it('remove a file in shared path', async function () {
      if (isBrowser) return this.skip()
      if (!aliceThread || !rootKey) throw Error('setup failed')

      bobBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await bobBuckets.getToken(bob)
      bobBuckets.withThread(aliceThread)

      try {
        await bobBuckets.removePath(rootKey, sharedFile)
        throw wrongError
      } catch (err) {
        expect(err).to.not.equal(wrongError)
        expect(err.message).to.include('permission denied')
      }
    })

    it('overwrite an existing shared file', async function () {
      if (isBrowser) return this.skip()
      if (!aliceThread || !rootKey) throw Error('setup failed')

      bobBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await bobBuckets.getToken(bob)
      bobBuckets.withThread(aliceThread)

      // Test that bob sees the same permissions, including himself
      const perms = await bobBuckets.pullPathAccessRoles(rootKey, sharedPath)
      expect(perms.get(bobPubKey)).to.equal(2)

      // Over-write the file in the shared path
      const stream = fs.createReadStream(path.join(pth, 'file2.jpg'), {
        highWaterMark: CHUNK_SIZE,
      })
      // Pushing to an existing shared file works: sharedFile = 'path/to/file2.jpg'
      try {
        await bobBuckets.pushPath(rootKey, sharedFile, stream)
        throw rightError
      } catch (err) {
        expect(err).to.equal(rightError)
      }
    })

    it('list existing', async function () {
      if (isBrowser) return this.skip()
      if (!aliceThread || !rootKey) throw Error('setup failed')

      aliceBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await aliceBuckets.getToken(alice)

      const aliceList = await aliceBuckets.existing()
      expect(aliceList).to.have.lengthOf(1)

      bobBuckets = await Buckets.withKeyInfo(apiKeyInfo, { host: addrApiurl })
      await bobBuckets.getToken(bob)

      const bobList = await bobBuckets.existing()
      expect(bobList).to.have.lengthOf(0)
    })
  })
})
