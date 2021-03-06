var SerialPort 	= require('serialport')
var gpio     	= require('rpi-gpio')
var serialPoll	= require('./serialPoll.js')
var influx		= require('influx')


module.exports = function(RED) {

	var oneHandle = false

	/* 
	 * Handle is a config node that handles communication with all the sensors 
	 * it asynchronosly switches the serial duplexer, and talks to the sensors one at a time
	 * then it sends the data to each individual sensor node so they can report it
	 *
	 * Handle is a constructor with lots of callbacks, you have to look carefully
	 * for the actual function calls that setup and start the async chain
	 */

	function Handle (config) 
	{
		RED.nodes.createNode(this, config)

		/* we use a global variable to check if more than one config node exists
		 * probably a bad idea and dumb 
		 */ 
		if(oneHandle)
		{
			this.error('only one sensor manager is supported per device')
			return
		}
		oneHandle = true

		const node = this
		/* some command strings the sensors take */ 
		const C02Command =       Buffer.from([255, 1, 134, 0, 0, 0, 0, 0, 121])
		const C02CommandZero =   Buffer.from([255, 1, 135, 0, 0, 0, 0, 0, 120]) 
		const C02CommandABCOFF = Buffer.from([255, 1, 136, 0, 0, 0, 0, 0, 119])
		const C02CommandABCON =	 Buffer.from([255, 1, 136, 160, 0, 0, 0, 0, 119])

		const PMSCommandRead  =  Buffer.from([66, 77, 226, 0, 0, 1, 113])
		const PMSCommandPassive = Buffer.from([66, 77, 225, 0, 0, 1, 112])
		const PMSCommandActive = Buffer.from([66, 77, 225, 0, 1, 1, 113])
		const PMSCommandWake = Buffer.from([66, 77, 228, 0, 1, 1, 116])
		const PMSCommandSleep = Buffer.from([66, 77, 228, 0, 0, 1, 115])

		/* 
		 * open a serial port
		 * this should have exception handling or it could break flows 
		 * need to test what happens if cant open serial 
		 */ 
		node.port = new SerialPort('/dev/serial0', {baudRate: 9600})
		node.port.on('error', function(err) {
			  console.log('Error: ', err.message)
			})
		
		node.autoConfigC02	= (config.autoConfigC02 || 'man') 

		/*this is where we keep track of nodes that want to receive C02 data or PMS data*/
		node.C02Register	= new Set()
		node.PMSRegister	= new Set()
		node.PMSInstantRegister = new Set()
		node.nextZero		= false
		node.ending			= false
		node.hardwareSerial = serialPoll.hardwareSerial()

		var acc = Buffer.from([])
		var context = 0

		/* this is a registered event that fires when the flow turns off*/ 
		node.on('close', function() 
		{
			oneHandle = false
			node.log('CLOSING ')
			node.port.close()
			node.ending = true
		})


		/* try and flush data from the serial port, probably doesn't work */ 
		function ghettoFlush ()
		{
			if (! (node.port.read())) 
			{
				return
			}

			if (! (node.port.read(1))) 
			{
				return
			}
		}

		/* the muxA and muxB functions
		 * 1. switch the serial multiplexer to other serial line
		 * 2. try and flush the serial buffer
		 * 3. run a supplied callback 
		 */ 
		function muxA (callback)
		{

			gpio.write(35, 0, function()
			{
				node.port.flush(function() 
				{
					ghettoFlush()

					acc = Buffer.from([])
					gpio.write(22, 0, function() 
					{
						callback()
					})
				})
			})
		}

		function muxB (callback)
		{
			gpio.write(35, 1, function()
			{
				node.port.flush(function()
				{
					ghettoFlush()
					acc = Buffer.from([])
					gpio.write(22, 0, function()
					{
						callback()
					})
				})
			})
		}

		/* tries to calculate a PMSChecksum in a buffer, and returns the result*/ 
		function PMSChecksum (buffer) 
		{
			var output = 0 

			for(var i = 0; i < 30; i++)
			{
				output += buffer.readUInt8(i)
				output = output & 65535
			}

			return output 
		}

		/* tries to calculate a c02 sensor checksum and return the result */ 
		function C02Checksum (buffer) 
		{
			const overFlow = function (i)
			{
				if(i >= 0 && i <= 256) return i
				if(i > 256) return overFlow( i - 256)
				if(i < 0)   return overFlow(256 - (-1 * i))
			}

			var output = 0 

			for(var i = 0; i < 8; i++)
				output = overFlow(output + buffer.readUInt8(i))

			output = overFlow( 255 - output)

			return output 
		}

		/*
		 * takes a buffer, runs a checksum 
		 * returns NULL if couldn't parse PMS data, otherwise returns an object 
		 */ 
		function parsePMS (buffer)
		{
			const calcCheck =  PMSChecksum(buffer) 
			const readCheck = (buffer.readUInt8(30) * 256  + buffer.readUInt8(31))

	

			if(calcCheck == readCheck)
			{
				return { pm10: buffer.readUInt8(10) * 256 + buffer.readUInt8(11), 
						 pm25: buffer.readUInt8(12) * 256 + buffer.readUInt8(13), 
						 pm100: buffer.readUInt8(14) * 256 + buffer.readUInt8(15),}
			}

			return undefined 
		}

		/* parse a reading from the PMS sensor */ 
		function parsePMSInstant (buffer) 
		{
			/* first calculate the checksum and check if it matches with the one sent by the sensor*/ 
			const calcCheck =  PMSChecksum(buffer) 
			const readCheck = (buffer.readUInt8(30) * 256  + buffer.readUInt8(31))

			if(calcCheck == readCheck)
			{
				/* if the checksum is correct, return data*/ 
				return { m03: buffer.readUInt8(16) * 256 + buffer.readUInt8(17), 
						 m05: buffer.readUInt8(18) * 256 + buffer.readUInt8(19), 
						 m1: buffer.readUInt8(20) * 256 + buffer.readUInt8(21),
						 m25: buffer.readUInt8(22) * 256 + buffer.readUInt8(23),
						 m5: buffer.readUInt8(24) * 256 + buffer.readUInt8(25), 
						 m10: buffer.readUInt8(26) * 256 + buffer.readUInt8(27), }
			}

			return undefined 
		}

		function parseC02 (buffer) 
		{
			if(parseInt(C02Checksum(buffer)) != parseInt(buffer.readUInt8(8)) )
			{
				var bString = '' 

				for(const b of buffer)
					bString += (',' + b)


				node.log(bString)
				
				return undefined
			}

			return parseInt( buffer.readUInt8(2) * 256 + buffer.readUInt8(3))
		}

		/*
		 * handles packets of data from the port.on('data' callback 
		 * accumilates using the global acc, and searches for the head of the C02 return data 
		 */ 
		function C02StreamParse (data)
		{
			acc = Buffer.concat( [acc, data])

			if(acc.length > 8 && acc.readUInt8( acc.length - 9) == 255 && acc.readUInt8( acc.length - 8) == 134)
			{
				const C02  = parseC02( acc.slice( acc.length - 9))

				for(const n of node.C02Register)
					n.output(C02)

				setTimeout(PMSListen, 1000)


			}
		}

		/* parses a buffer from the PMS sensor, and returns the data */ 
		function PMSStreamParse (data)
		{
			acc = Buffer.concat( [acc, data])

			if(acc.length > 31 && acc.readUInt8( acc.length - 32) == 66 && acc.readUInt8( acc.length - 31) == 77)
			{
				const PMS = parsePMS( acc.slice( acc.length - 32))
				const PMSI = parsePMSInstant( acc.slice( acc.length - 32))

				for(const n of node.PMSRegister)
					n.output(PMS)

				for(const n of node.PMSInstantRegister)
					n.output(PMSI)

				C02Listen()
			}
		}

		/*
		 * checks a flag and then parses using the C02 parser or the PMS parser
		 * set as a callback for port.on('data'
		 */
		function parseSwitcher (data)
		{

			if(node.ending) return 

			if(node.switchA) return C02StreamParse(data) 
			return PMSStreamParse(data)
		}

		/*
		 * toggles the flag that parseSwitcher reads 
		 */
		function PMSListen ()
		{
			if(node.ending) return
			context++
			acc = Buffer.from([])

			muxA( function()
			{
				node.port.write(PMSCommandRead)
				node.switchA = false

			})

			const currentContext = context
			setTimeout( function() 
			{
				if(context != currentContext) return 

				for(const n of node.PMSRegister)
					n.output(undefined)

				for(const n of node.PMSInstantRegister)
					n.output(undefined)

			
				C02Listen()
			}, 5000)
		}

		function C02Listen ()
		{
			if(node.ending) return
			context++
			acc = Buffer.from([])

			muxB( function()
			{
				/* checks a global flag to see if we need to zero the c02 sensor
				 * and then sends the c02 zero command down the serial */ 
				if(node.nextZero) 
				{
					node.nextZero = false 
					node.port.write(C02CommandZero) 
				}
				
				/* sends the 'read C02' command*/ 
				node.port.write(C02Command, function()
				{
					node.switchA = true
				})
			})

			const currentContext = context
			setTimeout( function() 
			{
				if(context != currentContext) return 

				for(const n of node.C02Register)
					n.output(undefined)

				PMSListen()
			}, 5000)
		}

		//setup our GPIO pins, and start the chain going 
		gpio.setup(22, gpio.DIR_OUT, function()
		{

			gpio.setup(35, gpio.DIR_OUT, function() 
			{

				if(node.autoConfigC02 == 'man') 
				{ 
					node.log('deactivating automatic C02 calibration')
					muxB( function()
					{
						node.port.write( C02CommandABCOFF)
					})
				}

				if(node.autoConfigC02 == 'auto') 
				{ 
					node.log('activating automatic C02 calibration')
					muxB( function()
					{
						node.port.write( C02CommandABCON)
					})
				}

				muxA( function() 
				{ 
				
					node.log('switching PMS to passive mode..')
					node.port.write(PMSCommandPassive)
					node.port.flush()
				
				})

				PMSListen()
				node.port.on('data', parseSwitcher)
			})
		}) 
	}

	/*
	 * node for C02 sensor
	 * registers itself with the config node, and then receives data from it 
	 * even if you have 100 C02 nodes, the config node is only checking the sensor once, not 100 times
	 */ 
	function C02Sensor (config) 
	{
		RED.nodes.createNode(this, config)
		const node = this

		//retrieve a reference to the config node, and register this node as a C02 reader 
		node.handle = RED.nodes.getNode(config.handle)
		node.handle.C02Register.add(node)

		//users can zero the C02 sensor through the node
		//tells the config node to zero the c02 sensor 
		node.on('input', function (msg) 
		{
			if(msg.payload == 'zero')
			{
				node.handle.nextZero = true 
			}
		})

		node.output = function (data)
		{
			if(data)
			{
				var msg = {} 
				msg.payload = parseInt(data)
				msg.topic = 'C02'
				msg.serial = node.handle.hardwareSerial
				msg.grafana = true //flag so the publish to grafana node doesn't let through garbage that destroys our databse

				node.send(msg)
				node.status({ fill:'green', shape:'dot', text: 'C02: ' + data})
				return
			}

			node.status({ fill:'red', shape:'dot', text: 'timeout..'})
		}
	}

	function PMSSensor (config)
	{
		RED.nodes.createNode(this, config) 
		const node = this

		node.handle = RED.nodes.getNode(config.handle) 
		node.handle.PMSRegister.add(node)

		node.output = function (data)
		{
			if(data)
			{
				const topics = ['PM1.0', 'PM2.5', 'PM10']

				const msg0 = {grafana: true, payload: data.pm10, topic: topics[0]}
				const msg1 = {grafana: true, payload: data.pm25, topic: topics[1]}
				const msg2 = {grafana: true, payload: data.pm100, topic: topics[2]}

				node.status({ fill:'green', shape:'dot', text: 'reading'})
				node.send([ msg0, msg1, msg2])

				return
			}

			node.status({ fill:'red', shape:'dot', text: 'timeout..'})
		}
	}

	function PMSInstantSensor (config) 
	{
		RED.nodes.createNode(this, config) 
		const node = this

		node.handle = RED.nodes.getNode(config.handle) 
		node.handle.PMSInstantRegister.add(node)

		node.output = function (data)
		{
			if(data)
			{
				const topics = ['Particles>0.3um', 'Particles>0.5um', 'Particles>1.0um', 
								'Particles>2.5um', 'Particles>5um', 'Particles>10um']

				const msg0 = {grafana: true, payload: data.m03, topic: topics[0]}
				const msg1 = {grafana: true, payload: data.m05, topic: topics[1]}
				const msg2 = {grafana: true, payload: data.m1, topic: topics[2]}
				const msg3 = {grafana: true, payload: data.m25, topic: topics[3]}
				const msg4 = {grafana: true, payload: data.m5, topic: topics[4]}
				const msg5 = {grafana: true, payload: data.m10, topic: topics[5]}

				node.status({ fill:'green', shape:'dot', text: 'reading'})
				node.send([ msg0, msg1, msg2, msg3, msg4, msg5])
				return
			}

			node.status({ fill:'red', shape:'dot', text: 'timeout..'})
		}
	}

	function BME280Parse (config)
	{	
		RED.nodes.createNode(this, config)
		const node = this 
		
		node.on('input',  function(msg)
		{
			const topics = ['temperature', 'humidity', 'pressure']

			const msg0 = {grafana: true, payload: msg.payload.temperature_C, 
						  topic: topics[0]}

			const msg1 = {grafana: true, payload: msg.payload.humidity, 
						  topic: topics[1]} 

			const msg2 = {grafana: true, payload: msg.payload.pressure_hPa, 
						  topic: topics[2]}

			node.send([msg0, msg1, msg2])
		})
	}

	function dataFormat (config)
	{
		RED.nodes.createNode(this, config)
		const node = this 
		const serial = node.credentials.location_name ? node.credentials.location_name : serialPoll.shortSerial()

		const username = node.credentials.username
		const password = node.credentials.password
		const geohash  = node.credentials.geohash ? node.credentials.geohash : 'nwc'

		const host = config.hostname 
		const port = config.port
		const database = config.database

		node.log(host + ' ' + port + ' ' + database)

		var client 
		var topicMap = new Map()
	
		if(host && port && database)
		{
			client = new influx.InfluxDB(
				{
					hosts: [{
						host: host,
						port: port,
						protocol: 'http',
						options: {}
					}],

					database:  database, 
					username:  username, 
					password:  password 
				})
		}
		else
		{
			node.error('database not setup, missing configuration')
		}
		if( !(username && password && geohash)) 
		{
			node.error('missing credentials, or geohash')
		}


		function sendIt ()
		{

			var points = []
			for( var v of topicMap.values())
			{
				v.fields.value /= v.increment
				points.push(v)
			}

			client.writePoints(points).catch(function(err)
			{
				node.error(err)
			})

			topicMap.clear()
			setTimeout(sendIt, 30000)
		}

		node.on('input', function(msg)
		{
			const urlA = 'g.aqeasy.com/' + serial

			if( !(username && password && geohash)) 
			{
				return
			}

			if( ! msg.grafana)
			{
				node.error(' please only inject easybotics weather nodes into this node!')
				node.error(' the generic "influxdb" nodes are very easy to setup if you need more diverse logging')
				return
			}

			var out = {} 

			out.measurement = msg.topic 
			out.fields = {value: msg.payload}
			out.tags   = {serial: '/' + serial,  geohash: geohash}
			out.timeStamp = new Date()
			out.increment = 1

			const prev = topicMap.get(msg.topic)
			if(prev)
			{
				out.increment = prev.increment + 1
				out.fields.value += prev.fields.value
			}

			topicMap.set( msg.topic, out)
			node.send({payload: urlA})


			node.status({fill:'green', shape:'dot', text: urlA})
		})

		sendIt()
	}

	RED.nodes.registerType('sensor-manager', Handle)
	RED.nodes.registerType('MHZ19-C02-Sensor', C02Sensor)
	RED.nodes.registerType('PMS5003-PM-Reading', PMSSensor)
	RED.nodes.registerType('PMS5003-Particle-Concentration', PMSInstantSensor)
	RED.nodes.registerType('BME280-Parse', BME280Parse)

	RED.nodes.registerType('publish-to-influxdb', dataFormat, 
		{
			credentials:
			{
				username: {type: 'text'},
				password: {type: 'password'},
				geohash:  {type: 'text'},
				location_name: {type: 'text'}
			}
		})
}
