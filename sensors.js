var SerialPort 	= require('serialport');
var gpio     	= require('rpi-gpio');





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

		var zeroNext = false;
		node.lastC02 = undefined; 
		node.lastPMS = undefined;
		node.lastPMSInstant = undefined; 

		node.zeroC02 = function ()
		{

			zeroNext = true;
		}

		if(!port)
		{
			port = new SerialPort('/dev/serial0', { baudRate: 9600});
		}

		function ghettoFlush ()
		{
			if (! (port.read(1))) return 0;

			var i = 1000;
			var inBuf = port.read(i);
			while (!inBuf)
				inBuf = port.read(i--);

			//node.log("dumped: " + (1000 - i )+ " bytes");
			return 1000 - i;
		}

		function muxA (callback)
		{
			gpio.write(35, 0, function()
				{

					ghettoFlush();
					gpio.write(22, 0, function() 
					{
						port.flush(callback);
					});
				});
		};

		function muxB (callback)
		{
				gpio.write(35, 1, function()
				{
					ghettoFlush();
					gpio.write(22, 0, function()
						{
							port.flush(callback);
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

		function readPMS () 
		{
			//check if we can even get a long enough buffer, if not return NULL
			const inBuf = port.read(32);
			if(!inBuf)	return undefined;

			//find the head of the buffer 
			var last = 66;
			var count = -1;
			for(const b of inBuf)
			{
				if(last == 66 && b == 77) break;
				count++;
				last = b;
			}

			//maybe we happen to have the head at 0
			if(count == 0) 
			{ 
				const out = 
				{
					pms: parsePMS(inBuf), 
					instant: parsePMSInstant(inBuf),
				}

				return out;

			};

			//otherwise try and read the remaining, and concat the remaining of the buffer
			const secondary = port.read(32 - count);
			try 
			{
				const fRead = Buffer.concat( [inBuf.slice(count, 32), secondary.slice(0, count)]);

				const out = 
				{
					pms: parsePMS(fRead), 
					instant: parsePMSInstant(fRead),
				}

				return out;

			}
			catch (e) 
			{
				node.log("caught from concatting: though");
				node.log(e);
				return undefined;
			};
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

		function readC02 ()
		{
			var inBuf = port.read(9);
			if(!inBuf) return undefined;

			return parseC02(inBuf);
		}

		function callBack( up = true, count = 0, delay = 2000) 
		{
			if(up)
			{
				muxA(function()
				{
					setTimeout(function()
					{
						const out = readPMS();
						if(out)
						{
							node.lastPMS = out.pms;
							node.lastPMSInstant = out.instant;
						}
						else 
						{
							node.lastPMS = undefined;
							node.lastPMSInstant = undefined;
						}


						callBack(!up, count + 1, delay);

					}, delay);
				});
			}
			else
			{
				muxB(function()
					{
						if(zeroNext) 
						{
							node.log("zeroing c02 sensor now..");
							port.write(C02CommandZero);
							zeroNext = false; 
						}

						port.write(C02Command);
						setTimeout(function()
						{
							port.drain(
							function() {
								node.lastC02 = readC02();
							});

							callBack(!up, count + 1, delay);
						}, delay); 

					});
			}
		}

		gpio.setup(22, gpio.DIR_OUT, function()
			{

			gpio.setup(35, gpio.DIR_OUT, function() 
				{

				 callBack();

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
