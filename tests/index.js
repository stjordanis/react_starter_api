const chai = require('chai')
const chaiAsPromised = require('chai-as-promised')
chai.should()
chai.expect()
chai.use(chaiAsPromised)
const url = 'http://localhost:5000/'
const request = require('supertest')(url)
const faker = require('faker')
const apiBenchmark = require('api-benchmark')

describe('user management', () => {
  it('returns all users', (done) => {
    request.post('graphql')
      .send({ query: 'mutation { signup(input: { email: "foo2@example.com", password: "123456" }) { clientMutationId } }' })
      .expect(200)
      .send({ query: '{ allUsers { nodes { email } } }'})
      .expect(200)
      .end((err, res) => {
        if (err) return done(err)
        res.should.have.property('body')
        res.body.data.allUsers.nodes[0].email.should.be.equal('foo2@example.com')
        done()
      })
  })

  /*it('return correct data for user', (done) => {
  })*/

  it('signup works for anyone', (done) => {
    request.post('graphql')
      .send({ query: 'mutation { signup(input: { email: "foo2@example.com", password: "123456" }) { clientMutationId } }' })
      .expect(200)
      .end((err, res) => {
        if (err) return done(err)
        res.should.have.property('body')
        res.body.data.should.have.property('signup')
        done()
      })
  })

  it('multi user signup is okay', (done) => {
    for (let i = 0; i < 100; i++) {
      request.post('graphql')
        .send({ query: `mutation { signup(input: { email: "${faker.internet.email()}", password: "${faker.internet.password()}" }) { clientMutationId } }` })
        .expect(200)
        .end((err, res) => {
          if (err) return done(err)
          res.should.have.property('body')
          res.body.data.should.have.property('signup')
        })
    }
    done()
  })

  it('doesn\'t allow to register for existing user', (done) => {
    request.post('graphql')
      .send({ query: 'mutation { signup(input: { email: "foo2@example.com", password: "123456" }) { clientMutationId } }'})
      .expect(200)
      .send({ query: 'mutation { signup(input: { email: "foo2@example.com", password: "123456" }) { clientMutationId } }'})
      .expect(200)
      .end((err, res) => {
        if (err) return done(err)
        res.body.errors[0].should.have.property('message')
        done()
      })
  })

  /*it('password reset works for anyone', (done) => {
  })*/
/*
  describe('existing users', () => {
    it('user update works', (done) => {
    })
  
    it('user delete works', (done) => {
    })

    it('login ok for users', (done) => {
    })
  
    it('login not ok for non-users', (done) => {
    })
  
    it('validation works for new users', (done) => {
    })
  
    it('wrong validation uuids not accepted', (done) => {
    })

    it('change email available for anyone', (done) => {
    })

    it('change role not available', (done) => {
    })

    it('', (done) => {
    })
  })*/
})

/*describe('cms', () => {
})

describe('blockchain', () => {
})
*/

const service = {
  server: `${url}`
}

const routes = {
  route: { route: 'graphql', method: 'post', data: { query: `mutation { signup(input: { email: "${faker.internet.email()}", password: "${faker.internet.password()}" }) { clientMutationId } }` } },
}

apiBenchmark.measure(service, routes, (err, res) => {
  console.log(res.server.route.stats)
})