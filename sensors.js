var SerialPort 	= require('serialport');
var gpio     	= require('rpi-gpio');
var serialPoll = require('./serialPoll.js');





module.exports = function(RED) {



	function Handle (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;
		const C02Command =       Buffer.from([255, 1, 134, 0, 0, 0, 0, 0, 121]);
		const C02CommandZero =   Buffer.from([255, 1, 135, 0, 0, 0, 0, 0, 120]); 
		const C02CommandABCOFF = Buffer.from([255, 1, 136, 0, 0, 0, 0, 0, 119]);
		const C02CommandABCON =	 Buffer.from([255, 1, 136, 160, 0, 0, 0, 0, 119]);

		const PMSCommandRead  =  Buffer.from([66, 77, 226, 0, 0, 1, 113]);

		const PMSCommandPassive = Buffer.from([66, 77, 225, 0, 0, 1, 112]);
		const PMSCommandActive = Buffer.from([66, 77, 225, 0, 1, 1, 113]);

		const PMSCommandWake = Buffer.from([66, 77, 228, 0, 1, 1, 116]);

		const PMSCommandSleep = Buffer.from([66, 77, 228, 0, 0, 1, 115]);

		node.port = new SerialPort('/dev/serial0', {baudRate: 9600});
		
		node.autoConfigC02	= (config.autoConfigC02 || "man"); 
		node.C02Register	= new Set();
		node.PMSRegister	= new Set();
		node.PMSInstantRegister = new Set();
		node.nextZero		= false;
		node.ending			= false;
		node.hardwareSerial = serialPoll.hardwareSerial();

		node.log(node.hardwareSerial);

		node.parser; 


		var acc = Buffer.from([]);
		var context = 0;

		node.on('close', function() 
			{
				node.log("CLOSING ");
				node.port.close();
				node.ending = true;
			});

		function ghettoFlush ()
		{
			if (! (node.port.read())) 
			{
				return;
			}

			if (! (node.port.read(1))) 
			{
				return;
			}
		}

		/*
		 * switches the Serial multiplexer to 0,0, flushes some buffers, and runs a callback 
		 */ 
		function muxA (callback)
		{

			gpio.write(35, 0, function()
				{
					node.port.flush(function() 
					{
					ghettoFlush();

					acc = Buffer.from([]);
					gpio.write(22, 0, function() 
					{
						callback();
					});
					});
				});
		};

		function muxB (callback)
		{
				gpio.write(35, 1, function()
				{
					node.port.flush(function()
					{
					ghettoFlush();
					acc = Buffer.from([]);
					gpio.write(22, 0, function()
						{
							callback();
						});
					});
				});
		};

		function PMSChecksum (buffer) 
		{
			var output = 0; 

			for(var i = 0; i < 30; i++)
			{
				output += buffer.readUInt8(i);
				output = output & 65535;
			}

			return output; 
		}

		function C02Checksum (buffer) 
		{
			const overFlow = function (i)
			{
				if(i >= 0 && i <= 256) return i;
				if(i > 256) return overFlow( i - 256);
				if(i < 0)   return overFlow(256 - (-1 * i));
			}

			var output = 0; 

			for(var i = 0; i < 8; i++)
				output = overFlow(output + buffer.readUInt8(i));

			output = overFlow( 255 - output);

			return output; 
		}

		/*
		 * takes a buffer, runs a checksum 
		 * returns NULL if couldn't parse PMS data, otherwise returns an object 
		 */ 
		function parsePMS (buffer)
		{
				const calcCheck =  PMSChecksum(buffer); 
				const readCheck = (buffer.readUInt8(30) * 256  + buffer.readUInt8(31));

				str = ''
				for(i = 0; i < 31; i++)
				{
					str += ',';
					str += buffer.readUInt8(i);
				}

				if(calcCheck == readCheck);
				{
					return { pm10: buffer.readUInt8(10) * 256 + buffer.readUInt8(11), 
							 pm25: buffer.readUInt8(12) * 256 + buffer.readUInt8(13), 
							 pm100: buffer.readUInt8(14) * 256 + buffer.readUInt8(15),}
				}
				node.log("dumped PMS due to checksum!");

				return undefined; 
		}

		function parsePMSInstant (buffer) 
		{
			const calcCheck =  PMSChecksum(buffer); 
			const readCheck = (buffer.readUInt8(30) * 256  + buffer.readUInt8(31));

			if(calcCheck == readCheck);
			{
				return { m03: buffer.readUInt8(16) * 256 + buffer.readUInt8(17), 
						 m05: buffer.readUInt8(18) * 256 + buffer.readUInt8(19), 
						 m1: buffer.readUInt8(20) * 256 + buffer.readUInt8(21),
						 m25: buffer.readUInt8(22) * 256 + buffer.readUInt8(23),
						 m5: buffer.readUInt8(24) * 256 + buffer.readUInt8(25), 
						 m10: buffer.readUInt8(26) * 256 + buffer.readUInt8(27), }
			}
			 node.log("dumped PMS due to checksum!");

			return undefined; 
		}

		function parseC02 (buffer) 
		{
			if(parseInt(C02Checksum(buffer)) != parseInt(buffer.readUInt8(8)) )
			{
				var bString = ""; 

				for(const b of buffer)
					bString += ("," + b);


				node.log("dumped c02 due to checksum");
				node.log(bString);
				
				return undefined;
			}

			return parseInt( buffer.readUInt8(2) * 256 + buffer.readUInt8(3));
		}

		/*
		 * handles packets of data from the port.on('data' callback 
		 * accumilates using the global acc, and searches for the head of the C02 return data 
		 */ 
		function C02StreamParse (data)
		{
			acc = Buffer.concat( [acc, data]);

			if(acc.length > 8 && acc.readUInt8( acc.length - 9) == 255 && acc.readUInt8( acc.length - 8) == 134)
			{
				const C02  = parseC02( acc.slice( acc.length - 9));

				for(const n of node.C02Register)
					n.output(C02);

				setTimeout(PMSListen, 1000);


			}
		}

		function PMSStreamParse (data)
		{
			acc = Buffer.concat( [acc, data]);

			if(acc.length > 31 && acc.readUInt8( acc.length - 32) == 66 && acc.readUInt8( acc.length - 31) == 77)
			{
				const PMS = parsePMS( acc.slice( acc.length - 32));
				const PMSI = parsePMSInstant( acc.slice( acc.length - 32));

				for(const n of node.PMSRegister)
					n.output(PMS);

				for(const n of node.PMSInstantRegister)
					n.output(PMSI);

				C02Listen();
			}
		}

		/*
		 * checks a flag and then parses using the C02 parser or the PMS parser
		 * set as a callback for port.on('data'
		 */
		function parseSwitcher (data)
		{

			if(node.ending) return; 

			if(node.switchA) return C02StreamParse(data); 
			return PMSStreamParse(data);
		}

		/*
		 * toggles the flag that parseSwitcher reads 
		 */
		function PMSListen ()
		{
			if(node.ending) return;
			context++;
			acc = Buffer.from([]);

			muxA( function()
			{
					node.port.write(PMSCommandRead);
					node.switchA = false;

			});

			const currentContext = context;
			setTimeout( function() 
			{
				if(context != currentContext) return; 

				for(const n of node.PMSRegister)
					n.output(undefined);

				for(const n of node.PMSInstantRegister)
					n.output(undefined);

			
				node.log("PMS timeout");
				C02Listen();
			}, 5000);
		}

		function C02Listen ()
		{
			if(node.ending) return;
			context++;
			acc = Buffer.from([]);

			muxB( function()
			{
				if(node.nextZero) 
				{
					node.nextZero = false; 
					node.port.write(C02CommandZero); 
				}
				
				node.port.write(C02Command, function()
					{
						node.switchA = true;
					});
			});

			const currentContext = context;
			setTimeout( function() 
			{
				if(context != currentContext) return; 

				for(const n of node.C02Register)
					n.output(undefined);

				node.log("c02 timeout");
				PMSListen();
			}, 5000);
		}

		//setup our GPIO pins, and start the chain going 
		gpio.setup(22, gpio.DIR_OUT, function()
			{

			gpio.setup(35, gpio.DIR_OUT, function() 
				{

					if(node.autoConfigC02 == "man") 
					{ 
						node.log("deactivating automatic C02 calibration");
						muxB( function()
							{
								node.port.write( C02CommandABCOFF);
							});
					};

					if(node.autoConfigC02 == "auto") 
					{ 
						node.log("activating automatic C02 calibration");
						muxB( function()
							{
								node.port.write( C02CommandABCON);
							});
					};

					muxA( function() 
					{ 
					
						node.log("switching PMS to passive mode..");
						node.port.write(PMSCommandPassive)
						node.port.flush();
					
					});

					PMSListen();
					node.port.on('data', parseSwitcher);
				});
			}); 
	};


	function C02Sensor (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;

		node.handle = RED.nodes.getNode(config.handle);
		node.handle.C02Register.add(node);

		node.on('input', function (msg) 
			{
				if(msg.payload == "zero")
				{
					node.handle.nextZero = true; 
				}
			});

		node.output = function (data)
		{
			if(data)
			{
				var msg = {}; 
				msg.payload = data;
				msg.topic = "C02 ppm";
				msg.measurement = node.handle.hardwareSerial + '/' + "C02";

				node.send(msg);
				node.status({ fill:"green", shape:"dot", text: "C02: " + data});
				return;
			}

			node.status({ fill:"red", shape:"dot", text: "timeout.."});
		}
	}

	function PMSSensor (config)
	{
		RED.nodes.createNode(this, config); 
		const node = this;

		node.handle = RED.nodes.getNode(config.handle); 
		node.handle.PMSRegister.add(node);

		node.output = function (data)
		{
			if(data)
			{
				const serial = node.handle.hardwareSerial;
				const topics = ["PM1.0", "PM2.5", "PM10"];

				const msg0 = {payload: data.pm10, topic: topics[0], 
							  measurement: serial + '/' + topics[0]};


				const msg1 = {payload: data.pm25, topic: topics[1], 
							  measurement: serial + '/' + topics[1]};


				const msg2 = {payload: data.pm100, topic: topics[2], 
							  measurement: serial + '/' + topics[2]};

				node.status({ fill:"green", shape:"dot", text: "reading"});
				node.send([ msg0, msg1, msg2]);


				return;
			}

			node.status({ fill:"red", shape:"dot", text: "timeout.."});
		}
	}


	function PMSInstantSensor (config) 
	{
		RED.nodes.createNode(this, config); 
		const node = this;

		node.handle = RED.nodes.getNode(config.handle); 
		node.handle.PMSInstantRegister.add(node);

		node.output = function (data)
		{
			if(data)
			{
				const serial = node.handle.hardwareSerial;
				const topics = ["Particles>0.3um", "Particles>0.5um", "Particles>1.0um", 
								"Particles>2.5um", "Particles>5um", "Particles>10um"];

				const msg0 = {payload: data.m03, topic: topics[0], 
							  measurement: serial + '/' + topics[0]};

				const msg1 = {payload: data.m05, topic: topics[1], 
							  measurement: serial + '/' + topics[1]};

				const msg2 = {payload: data.m1, topic: topics[2], 
							  measurement: serial + '/' + topics[2]};

				const msg3 = {payload: data.m25, topic: topics[3], 
							  measurement: serial + '/' + topics[3]};

				const msg4 = {payload: data.m5, topic: topics[4], 
							  measurement: serial + '/' + topics[4]};

				const msg5 = {payload: data.m10, topic: topics[5], 
							  measurement: serial + '/' + topics[5]};

				node.status({ fill:"green", shape:"dot", text: "reading"});
				node.send([ msg0, msg1. msg2, msg3, msg4, msg5]);
				return;
			}

			node.status({ fill:"red", shape:"dot", text: "timeout.."});
		}
	}

	function BME280Parse (config)
	{	
		RED.nodes.createNode(this, config);
		const node = this; 
		const serial = serialPoll.hardwareSerial();
		
		node.on('input',  function(msg)
		{
			const topics = ["temperature", "humidity", "pressure"];

			const msg0 = {payload: msg.payload.temperature_C, 
						  topic: topics[0], 
						  measurement: serial + '/' + topics[0]};

			const msg1 = {payload: msg.payload.humidity, 
						  topic: topics[1], 
						  measurement: serial + '/' + topics[1]};

			const msg2 = {payload: msg.payload.pressure_hPa, 
						  topic: topics[2], 
						  measurement: serial + '/' + topics[2]};

			node.send([msg0, msg1, msg2]);
		});
	}


	RED.nodes.registerType("mux-handle", Handle);
	RED.nodes.registerType("MHZ19-C02-Sensor", C02Sensor);
	RED.nodes.registerType("PMS5003-PM-Reading", PMSSensor);
	RED.nodes.registerType("PMS5003-Particle-Concentration", PMSInstantSensor);
	RED.nodes.registerType("BME280-Parse", BME280Parse);
}
