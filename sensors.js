var SerialPort 	= require('serialport');
var gpio     	= require('rpi-gpio');
var nodeRegister;





module.exports = function(RED) {

	var port; 

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

	function Handle (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;
		const C02Command = Buffer.from([255, 1, 134, 0, 0, 0, 0, 0, 121]);
		const C02CommandZero = Buffer.from([255, 1, 135, 0, 0, 0, 0, 0, 120]); 

		node.lastC02 = undefined; 

		var acc = Buffer.from([]);


		if(!port)
		{
			port = new SerialPort('/dev/serial0', { baudRate: 9600});
		}

		function ghettoFlush ()
		{
			if (! (port.read())) 
			{
				return;
			}

			if (! (port.read(1))) 
			{
				return;
			}

			var i = 2048;
			var inBuf = port.read(i);
			while (!inBuf)
				inBuf = port.read(i--);

			return 1000 - i;
		}


		//PMS
		function muxA (callback)
		{
			gpio.write(35, 0, function()
				{
					port.flush(function() 
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

		//C02
		function muxB (callback)
		{
				gpio.write(35, 1, function()
				{
					port.flush(function()
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

		function parsePMS (buffer)
		{
				const calcCheck =  PMSChecksum(buffer); 
				const readCheck = (buffer.readUInt8(30) * 256  + buffer.readUInt8(31));

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
						 m1: buffer.readUInt8(20) * 256 + buffer.readUInt8(21),}
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

		function C02StreamParse (data)
		{
			acc = Buffer.concat( [acc, data]);

			if(acc.length > 8 && acc.readUInt8( acc.length - 9) == 255 && acc.readUInt8( acc.length - 8) == 134)
			{
				node.log("c02 command found!");
				node.lastC02 = parseC02( acc.slice( acc.length - 9));
				PMSListen();
			}

		}

		function PMSStreamParse (data)
		{
			acc = Buffer.concat( [acc, data]);

			if(acc.length > 31 && acc.readUInt8( acc.length - 32) == 66 && acc.readUInt8( acc.length - 31) == 77)
			{
				node.log("PMS command found!");
				node.lastPMS = parsePMS(acc.slice( acc.length - 32));
				node.lastPMSInstant = parsePMSInstant(acc.slice( acc.length - 32));
				C02Listen();
			}

		}

		function parseSwitcher (data)
		{
			if(node.switchA) return C02StreamParse(data); 
			return PMSStreamParse(data);
		}



		function PMSListen ()
		{
			acc = Buffer.from([]);

			muxA( function()
			{

				node.switchA = false;
				//port.on('data', PMSStreamParse);
			});
		}

		function C02Listen ()
		{
			acc = Buffer.from([]);

			muxB( function()
			{
				port.write(C02Command, function()
					{
						node.switchA = true;
					//	port.on('data', C02StreamParse);
					});
			});
		}



		gpio.setup(22, gpio.DIR_OUT, function()
			{

			gpio.setup(35, gpio.DIR_OUT, function() 
				{

					PMSListen();
					port.on('data', parseSwitcher);

				});
			}); 
	};


	function C02Sensor (config) 
	{
		RED.nodes.createNode(this, config);
		const node = this;

		node.handle = RED.nodes.getNode(config.handle);
	

		function outRecall ()
		{
			if(node.handle.lastC02 != undefined)
			node.send( {payload: node.handle.lastC02});

			setTimeout(function()
				{
					outRecall();

				}, 2000);
		}

		node.on('input', function(msg) 
		{
			if(msg.topic == "zero")
			{
				node.handle.zeroC02();
			}
		});



		outRecall();
	}

	function PMSSensor (config)
	{
		RED.nodes.createNode(this, config); 
		const node = this;

		node.handle = RED.nodes.getNode(config.handle); 

		function outRecall ()
		{

			setTimeout(function()
				{
					outRecall();

				}, 2000);

			if(node.handle.lastPMS)
			node.send([ {payload: node.handle.lastPMS.pm10}, {payload: node.handle.lastPMS.pm25}, {payload: node.handle.lastPMS.pm100}]);
		}

		outRecall();
	}

	function PMSInstantSensor (config) 
	{
		RED.nodes.createNode(this, config); 
		const node = this;

		node.handle = RED.nodes.getNode(config.handle); 

		function outRecall ()
		{
			if(node.handle.lastPMSInstant)
			{
				node.send([ {payload: node.handle.lastPMSInstant.m03}, {payload: node.handle.lastPMSInstant.m05}, {payload: node.handle.lastPMSInstant.m1}]);
			}
			setTimeout(function()
				{
					outRecall();

				}, 2000);


		}

		outRecall();
	}


	RED.nodes.registerType("mux-handle", Handle);
	RED.nodes.registerType("mux-c02-read", C02Sensor);
	RED.nodes.registerType("mux-PMS-read", PMSSensor);
	RED.nodes.registerType("mux-PMSInstant-read", PMSInstantSensor);
}
